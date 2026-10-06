//! Host side of the fresh Agent BTCC storage source path.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use butler_turn::btcc::{StorageError, begin_storage_startup, bootstrap_fresh_storage};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FreshStorageBootstrap {
    pub(crate) path: PathBuf,
    pub(crate) manifest_id: String,
}

#[derive(Debug)]
pub(crate) enum FreshStorageError {
    /// A data folder from a release that predates the BTCC runtime store:
    /// an App DB without `agent-runtime/btcc.sqlite`. Not migrated (owner
    /// decision); the folder is left untouched.
    ExistingData(PathBuf),
    Storage(StorageError),
}

impl fmt::Display for FreshStorageError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExistingData(root) => write!(
                out,
                "legacy data folder is unsupported: {} was created by an older Butler release \
                 (it has app-server/butler-client.sqlite but no agent-runtime/btcc.sqlite) and \
                 was left unchanged. Move this folder aside, or set BUTLER_DATA to a new folder, \
                 and start Butler again.",
                root.display()
            ),
            Self::Storage(error) => write!(out, "{error}"),
        }
    }
}

impl std::error::Error for FreshStorageError {}

/// Whether `butler_data` is a pre-BTCC data folder the agent refuses to
/// start on (and so must not write into).
pub(crate) fn is_unsupported_legacy_data(butler_data: &Path) -> bool {
    !butler_data.join("agent-runtime/btcc.sqlite").exists()
        && butler_data.join("app-server/butler-client.sqlite").exists()
}

/// Source fresh-install ordering: reject existing data, establish a process
/// readiness fence, prepare the receipt, publish, activate, then validate.
pub(crate) fn prepare_fresh_btcc_storage(
    butler_data: &Path,
    runtime_version: &str,
) -> Result<FreshStorageBootstrap, FreshStorageError> {
    if butler_data.join("app-server/butler-client.sqlite").exists() {
        return Err(FreshStorageError::ExistingData(butler_data.to_owned()));
    }
    let path = butler_data.join("agent-runtime/btcc.sqlite");
    let fence = format!("native-service-pre-readiness:{}", std::process::id());
    let completed_at = butler_core::js_date::iso_from_system_time(SystemTime::now());
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
        let manifest_id = begin_storage_startup(&path).map_err(FreshStorageError::Storage)?;
        return Ok(FreshStorageBootstrap { path, manifest_id });
    }
    prepare_fresh_btcc_storage(butler_data, runtime_version)
}
