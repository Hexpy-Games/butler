//! Inspecting a project capsule: headings, source counts and refresh failures.

use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, mutable_paths::ensure_data_authority,
};

use super::{source, write::failure_log_path};
use crate::cognition::CognitionCode;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapsuleInspectReport {
    pub ok: bool,
    pub project_id: String,
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
    pub updated_at: Option<String>,
    pub section_headings: Vec<String>,
    pub source_counts: Option<CapsuleSourceCounts>,
    pub refresh_failures: RefreshFailures,
    pub diagnostics: Vec<String>,
    pub privacy: ProjectCapsuleInspectPrivacy,
}

/// The source counts a capsule records in its Freshness section.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleSourceCounts {
    pub registry: u64,
    pub tasks: u64,
    pub explicit_feedback: u64,
    pub project_hot_cache: u64,
    pub memory_evidence: u64,
    pub graph_evidence: u64,
    pub promoted: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RefreshFailures {
    pub count: usize,
    pub latest: Option<ProjectCapsuleFailureRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapsuleFailureRecord {
    pub ts: String,
    pub project_id: String,
    pub phase: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapsuleInspectPrivacy {
    pub raw_text_included: bool,
}

pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
) -> CognitionResult<ProjectCapsuleInspectReport> {
    let memory_root = paths.memory_root(data_root);
    let path = source::capsule_path(&memory_root, project_id);
    let failure_path = failure_log_path(data_root, paths);
    ensure_data_authority(data_root, &[&memory_root, &path, &failure_path])?;

    let exists = path
        .try_exists()
        .map_err(|source| inspect_error().with_source(source))?;
    let body = if exists {
        fs::read_to_string(&path)
            .map(|text| butler_core::public_text::trim_js_whitespace(&text).to_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let failures = read_failures(&failure_path, project_id);
    let mut diagnostics = Vec::new();
    let mut bytes = 0;
    let mut updated_at = None;
    if exists {
        match fs::metadata(&path) {
            Ok(metadata) => {
                bytes = metadata.len();
                updated_at = metadata
                    .modified()
                    .ok()
                    .map(epoch_millis)
                    .and_then(butler_core::js_date::format_iso_millis);
                if updated_at.is_none() {
                    diagnostics.push("project capsule stat failed".to_owned());
                }
            }
            Err(_) => diagnostics.push("project capsule stat failed".to_owned()),
        }
    } else {
        diagnostics.push("project capsule is missing".to_owned());
    }
    if failures.count > 0 {
        diagnostics.push("project capsule has refresh failure history".to_owned());
    }
    let source_counts = if exists {
        parse_source_counts(&body)
    } else {
        None
    };
    if exists && source_counts.is_none() {
        diagnostics.push("project capsule source counts are missing".to_owned());
    }
    let section_headings = body
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("##")?;
            rest.chars()
                .next()
                .is_some_and(butler_core::public_text::is_js_whitespace)
                .then(|| butler_core::public_text::trim_js_whitespace(rest).to_owned())
        })
        .collect();

    Ok(ProjectCapsuleInspectReport {
        ok: true,
        project_id: project_id.to_owned(),
        path: path.to_string_lossy().into_owned(),
        exists,
        bytes,
        updated_at,
        section_headings,
        source_counts,
        refresh_failures: failures,
        diagnostics,
        privacy: ProjectCapsuleInspectPrivacy {
            raw_text_included: false,
        },
    })
}

/// The `source_counts:` line of the Freshness section; `None` when the
/// capsule has none.
fn parse_source_counts(body: &str) -> Option<CapsuleSourceCounts> {
    let line = body.lines().find(|line| line.contains("source_counts:"))?;
    let counts = count_pairs(line);
    let count = |key: &str| counts.get(key).copied().unwrap_or(0);
    Some(CapsuleSourceCounts {
        registry: count("registry"),
        tasks: count("tasks"),
        explicit_feedback: count("explicit_feedback"),
        project_hot_cache: count("project_hot_cache"),
        memory_evidence: count("memory_evidence"),
        graph_evidence: count("graph_evidence"),
        promoted: count("promoted"),
    })
}

/// Every `name=digits` pair in the line (a later pair wins).
fn count_pairs(line: &str) -> std::collections::HashMap<&str, u64> {
    let mut counts = std::collections::HashMap::new();
    let bytes = line.as_bytes();
    let is_name = |byte: &u8| byte.is_ascii_lowercase() || *byte == b'_';
    let mut index = 0;
    while let Some(byte) = bytes.get(index) {
        if !is_name(byte) {
            index += 1;
            continue;
        }
        let start = index;
        while bytes.get(index).is_some_and(is_name) {
            index += 1;
        }
        let end = index;
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        let value_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        let value = line
            .get(value_start..index)
            .filter(|digits| !digits.is_empty())
            .and_then(|digits| digits.parse::<u64>().ok());
        if let (Some(value), Some(name)) = (value, line.get(start..end)) {
            counts.insert(name, value);
        }
    }
    counts
}

fn read_failures(path: &Path, project_id: &str) -> RefreshFailures {
    let Ok(text) = fs::read_to_string(path) else {
        return RefreshFailures {
            count: 0,
            latest: None,
        };
    };
    let records = text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let ts = value.get("ts")?.as_str()?;
            let recorded_project = value.get("projectId")?.as_str()?;
            let phase = value.get("phase")?.as_str()?;
            let message = value.get("message")?.as_str()?;
            (recorded_project == project_id && matches!(phase, "lock" | "refresh")).then(|| {
                ProjectCapsuleFailureRecord {
                    ts: ts.to_owned(),
                    project_id: recorded_project.to_owned(),
                    phase: phase.to_owned(),
                    message: message.to_owned(),
                }
            })
        })
        .collect::<Vec<_>>();
    let latest = records.last().cloned();
    RefreshFailures {
        count: records.len().min(20),
        latest,
    }
}

fn epoch_millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => {
            i64::try_from(duration.as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        }
        Err(error) => {
            -i64::try_from(error.duration().as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        }
    }
}

fn inspect_error() -> CognitionError {
    CognitionError::new(
        CognitionCode::ProjectCapsuleInspectFailed,
        "Could not inspect project memory capsule",
    )
}
