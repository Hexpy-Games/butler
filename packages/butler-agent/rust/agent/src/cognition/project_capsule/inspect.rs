use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{Value, json};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, mutable_paths::ensure_data_authority,
};

use super::{source, write::failure_log_path};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectCapsuleInspectReport {
    pub ok: bool,
    pub project_id: String,
    pub path: String,
    pub exists: bool,
    pub bytes: u64,
    pub updated_at: Option<String>,
    pub section_headings: Vec<String>,
    pub source_counts: Option<Value>,
    pub refresh_failures: RefreshFailures,
    pub diagnostics: Vec<String>,
    pub privacy: ProjectCapsuleInspectPrivacy,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct RefreshFailures {
    pub count: usize,
    pub latest: Option<ProjectCapsuleFailureRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectCapsuleFailureRecord {
    pub ts: String,
    pub project_id: String,
    pub phase: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectCapsuleInspectPrivacy {
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

    let exists = path.try_exists().map_err(|_| inspect_error())?;
    let body = if exists {
        fs::read_to_string(&path)
            .map(|text| crate::public_text::trim_js_whitespace(&text).to_owned())
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
                    .and_then(epoch_millis)
                    .and_then(crate::js_date::format_iso_millis);
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
                .is_some_and(crate::public_text::is_js_whitespace)
                .then(|| crate::public_text::trim_js_whitespace(rest).to_owned())
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

fn parse_source_counts(body: &str) -> Option<Value> {
    let line = body.lines().find(|line| line.contains("source_counts:"))?;
    let mut counts = serde_json::Map::new();
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_lowercase() && bytes[index] != b'_' {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && (bytes[index].is_ascii_lowercase() || bytes[index] == b'_') {
            index += 1;
        }
        let end = index;
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        let value_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if value_start == index {
            continue;
        }
        if let Ok(value) = line[value_start..index].parse::<u64>() {
            counts.insert(line[start..end].to_owned(), json!(value));
        }
    }
    let count = |key: &str| counts.get(key).cloned().unwrap_or_else(|| json!(0));
    Some(json!({
        "registry": count("registry"),
        "tasks": count("tasks"),
        "explicitFeedback": count("explicit_feedback"),
        "projectHotCache": count("project_hot_cache"),
        "memoryEvidence": count("memory_evidence"),
        "graphEvidence": count("graph_evidence"),
        "promoted": count("promoted"),
    }))
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

fn epoch_millis(time: SystemTime) -> Option<i64> {
    let millis = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => {
            i64::try_from(duration.as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        }
        Err(error) => {
            -i64::try_from(error.duration().as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        }
    };
    Some(millis)
}

fn inspect_error() -> CognitionError {
    CognitionError::new(
        "project_capsule_inspect_failed",
        "Could not inspect project memory capsule",
    )
}
