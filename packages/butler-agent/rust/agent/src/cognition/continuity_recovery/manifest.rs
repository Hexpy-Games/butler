use std::{collections::BTreeMap, fs, io::Write, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, mutable_paths::ensure_data_authority,
};

use super::SCHEMA;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct ContinuityRecoveryManifest {
    pub schema_version: String,
    pub manifest_id: String,
    pub project_id: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub inventory_by_project: BTreeMap<String, usize>,
    pub candidates: Vec<RecoveryCandidate>,
    pub approved_candidate_ids: Vec<String>,
    pub quarantine: Vec<RecoveryQuarantine>,
    pub before: RecoveryBefore,
    pub after: Option<RecoveryAfter>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct RecoveryCandidate {
    pub candidate_id: String,
    pub project_id: String,
    pub conversation_session_id: String,
    pub conversation_turn_id: String,
    pub inbound_message_id: String,
    pub outbound_message_id: String,
    pub completed_at: String,
    pub preview: String,
    pub body: String,
    pub body_sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RecoveryQuarantine {
    pub conversation_session_id: String,
    pub conversation_turn_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct RecoveryBefore {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub body_base64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RecoveryAfter {
    pub bytes: usize,
    pub sha256: String,
}

pub(super) fn read(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest_id: &str,
) -> CognitionResult<Option<ContinuityRecoveryManifest>> {
    let path = manifest_path(data_root, paths, manifest_id)?;
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("continuity_recovery_manifest_read_failed")),
    };
    let value: Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if value["schema_version"] != SCHEMA || value["manifest_id"] != manifest_id {
        return Ok(None);
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| error("continuity_recovery_manifest_invalid"))
}

pub(super) fn required(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest_id: &str,
) -> CognitionResult<ContinuityRecoveryManifest> {
    read(data_root, paths, manifest_id)?
        .ok_or_else(|| error("continuity_recovery_manifest_not_found"))
}

pub(super) fn approve(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    mut manifest: ContinuityRecoveryManifest,
    candidate_ids: Option<Vec<String>>,
) -> CognitionResult<ContinuityRecoveryManifest> {
    if matches!(manifest.status.as_str(), "applied" | "rolled_back") {
        return Err(error("continuity_recovery_manifest_terminal"));
    }
    let available = manifest
        .candidates
        .iter()
        .map(|candidate| candidate.candidate_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut approved = match candidate_ids {
        None => available
            .iter()
            .map(|id| (*id).to_owned())
            .collect::<Vec<_>>(),
        Some(ids) => ids
            .into_iter()
            .map(|id| crate::public_text::trim_js_whitespace(&id).to_owned())
            .filter(|id| !id.is_empty())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>(),
    };
    if approved.is_empty() || approved.iter().any(|id| !available.contains(id.as_str())) {
        return Err(error("continuity_recovery_candidate_invalid"));
    }
    approved.sort();
    manifest.status = "approved".into();
    manifest.approved_candidate_ids = approved;
    manifest.updated_at = now();
    write(data_root, paths, &manifest)?;
    Ok(manifest)
}

pub(super) fn write(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest: &ContinuityRecoveryManifest,
) -> CognitionResult<()> {
    let path = manifest_path(data_root, paths, &manifest.manifest_id)?;
    let parent = path
        .parent()
        .ok_or_else(|| error("continuity_recovery_manifest_path_invalid"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(io_error)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent).map_err(io_error)?;
    ensure_data_authority(data_root, &[parent, &path])?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error("continuity_recovery_manifest_path_invalid"))?;
    let temp = parent.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
    let mut created_temp = false;
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(io_error)?;
        created_temp = true;
        serde_json::to_writer_pretty(&mut file, manifest).map_err(|failure| {
            CognitionError::new(
                "continuity_recovery_manifest_write_failed",
                failure.to_string(),
            )
        })?;
        file.write_all(b"\n").map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        fs::rename(&temp, &path).map_err(io_error)
    })();
    if created_temp {
        let _ = fs::remove_file(temp);
    }
    result
}

pub(super) fn manifest_path(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    manifest_id: &str,
) -> CognitionResult<std::path::PathBuf> {
    let memory_root = paths.memory_root(data_root);
    let safe = safe_id(manifest_id);
    let path = memory_root
        .join("recovery/manifests")
        .join(format!("{safe}.json"));
    ensure_data_authority(data_root, &[&memory_root, &path])?;
    Ok(path)
}

pub(super) fn safe_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(160)
        .collect()
}

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn io_error(error: std::io::Error) -> CognitionError {
    CognitionError::new(
        "continuity_recovery_manifest_write_failed",
        error.to_string(),
    )
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, code)
}
