//! Host side of the fresh Agent BTCC storage source path.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::btcc::{StorageError, bootstrap_fresh_storage, read_activated_storage_manifest};

use super::iso_timestamp;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FreshStorageBootstrap {
    pub(crate) path: PathBuf,
    pub(crate) manifest_id: String,
}

#[derive(Debug)]
pub(crate) enum FreshStorageError {
    ExistingData,
    Storage(StorageError),
}

impl fmt::Display for FreshStorageError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExistingData => write!(out, "legacy Agent BTCC migration is unsupported"),
            Self::Storage(error) => write!(out, "{error}"),
        }
    }
}

impl std::error::Error for FreshStorageError {}

/// Source fresh-install ordering: reject existing data, establish a process
/// readiness fence, prepare the receipt, publish, activate, then validate.
pub(crate) fn prepare_fresh_btcc_storage(
    butler_data: &Path,
    runtime_version: &str,
) -> Result<FreshStorageBootstrap, FreshStorageError> {
    if butler_data.join("app-server/butler-client.sqlite").exists() {
        return Err(FreshStorageError::ExistingData);
    }
    let path = butler_data.join("agent-runtime/btcc.sqlite");
    let fence = format!("native-service-pre-readiness:{}", std::process::id());
    let completed_at = iso_timestamp(SystemTime::now());
    let manifest_id = bootstrap_fresh_storage(&path, &fence, runtime_version, &completed_at)
        .map_err(FreshStorageError::Storage)?;
    Ok(FreshStorageBootstrap { path, manifest_id })
}

/// Resume a current activated target without writing it. Only a genuinely
/// absent target enters the source fresh-install path.
pub(crate) fn prepare_btcc_storage(
    butler_data: &Path,
    runtime_version: &str,
) -> Result<FreshStorageBootstrap, FreshStorageError> {
    let path = butler_data.join("agent-runtime/btcc.sqlite");
    if path.exists() {
        let manifest_id =
            read_activated_storage_manifest(&path).map_err(FreshStorageError::Storage)?;
        return Ok(FreshStorageBootstrap { path, manifest_id });
    }
    prepare_fresh_btcc_storage(butler_data, runtime_version)
}
