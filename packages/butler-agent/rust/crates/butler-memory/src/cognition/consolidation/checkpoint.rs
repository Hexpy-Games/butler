//! Consolidation checkpoints: the durable per-run record of completed phases and errors.

use std::{
    fs::{self, File, OpenOptions},
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
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| error(CognitionCode::MemoryConsolidationStateWriteFailed))?;
    let temporary = parent.join(format!("{file_name}.tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|source| {
            error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
        })?;
        file.write_all(&bytes).map_err(|source| {
            error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
        })?;
        file.sync_all().map_err(|source| {
            error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
        })?;
        fs::rename(&temporary, path).map_err(|source| {
            error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
        })?;
        #[cfg(unix)]
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| {
                error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
            })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder.create(path).map_err(|source| {
            error(CognitionCode::MemoryConsolidationStateWriteFailed).with_source(source)
        })
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(path)
            .map_err(|source| error("memory_consolidation_state_write_failed").with_source(source))
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, code.as_str())
}
