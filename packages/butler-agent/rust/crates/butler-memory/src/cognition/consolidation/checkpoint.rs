//! Consolidation checkpoints: the durable per-run record of completed phases and errors.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use crate::cognition::CognitionCode;
use serde::Serialize;

use crate::cognition::{CognitionError, CognitionPathEnvironment, CognitionResult};

use super::types::{CHECKPOINT_SCHEMA, Checkpoint, Phase};

pub(crate) const MAX_STATE_JSON_BYTES: usize = 1024 * 1024;
const MAX_RUN_ID_BYTES: usize = 128;

pub(crate) fn checkpoint_path(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    run_id: &str,
) -> CognitionResult<PathBuf> {
    validate_run_id(run_id)?;
    Ok(environment
        .cognition_root(data_root)
        .join("consolidation/checkpoints")
        .join(format!("{run_id}.json")))
}

pub(crate) fn summary_path(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    run_id: &str,
) -> CognitionResult<PathBuf> {
    validate_run_id(run_id)?;
    Ok(environment
        .cognition_root(data_root)
        .join("consolidation/runs")
        .join(format!("{run_id}.json")))
}

pub(crate) fn read_checkpoint(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    run_id: &str,
) -> CognitionResult<Option<Checkpoint>> {
    let path = checkpoint_path(data_root, environment, run_id)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(error(
                CognitionCode::MemoryConsolidationCheckpointReadFailed,
            ));
        }
    };
    let mut bytes = Vec::with_capacity(MAX_STATE_JSON_BYTES.min(16 * 1024));
    file.take((MAX_STATE_JSON_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|source| {
            error(CognitionCode::MemoryConsolidationCheckpointReadFailed).with_source(source)
        })?;
    if bytes.len() > MAX_STATE_JSON_BYTES {
        return Err(error(CognitionCode::MemoryConsolidationStateTooLarge));
    }
    let checkpoint: Checkpoint = serde_json::from_slice(&bytes).map_err(|source| {
        error(CognitionCode::MemoryConsolidationCheckpointInvalid).with_source(source)
    })?;
    if checkpoint.schema != CHECKPOINT_SCHEMA
        || checkpoint.run_id != run_id
        || checkpoint.next_phase_index > Phase::ALL.len()
    {
        return Err(error(CognitionCode::MemoryConsolidationCheckpointInvalid));
    }
    Ok(Some(checkpoint))
}

pub(crate) fn write_checkpoint(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    checkpoint: &Checkpoint,
) -> CognitionResult<()> {
    if checkpoint.schema != CHECKPOINT_SCHEMA || checkpoint.next_phase_index > Phase::ALL.len() {
        return Err(error(CognitionCode::MemoryConsolidationCheckpointInvalid));
    }
    let path = checkpoint_path(data_root, environment, &checkpoint.run_id)?;
    write_atomic(&path, checkpoint)
}

pub(crate) fn write_atomic<T: Serialize>(path: &Path, value: &T) -> CognitionResult<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|source| {
        error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
    })?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_JSON_BYTES {
        return Err(error(CognitionCode::MemoryConsolidationStateTooLarge));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    create_private_directories(parent)?;
    butler_platform::secure_fs::replace_private(
        path,
        |file| file.write_all(&bytes),
        std::convert::identity,
    )
    .map_err(|source| error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source))
}

pub(crate) fn validate_run_id(run_id: &str) -> CognitionResult<()> {
    if run_id.is_empty()
        || run_id.len() > MAX_RUN_ID_BYTES
        || run_id == "."
        || run_id == ".."
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(error(CognitionCode::MemoryConsolidationRunIdInvalid));
    }
    Ok(())
}

fn create_private_directories(path: &Path) -> CognitionResult<()> {
    let mut builder = fs::DirBuilder::new();
    butler_platform::secure_fs::owner_only_dirs(builder.recursive(true));
    builder.create(path).map_err(|source| {
        error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
    })
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
