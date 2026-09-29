use std::path::Path;
use std::sync::Arc;

use butler_turn::btcc::BtccError;

use super::stores::RuntimeStores;
use crate::host::memory_jobs::sync::MemorySync;
use crate::host::{ConversationObserver, WorkStreams};

pub(super) async fn close_after_memory_sync_error(
    result: Result<MemorySync, BtccError>,
    observer: &Arc<ConversationObserver>,
    work_streams: &Arc<WorkStreams>,
    stores: &RuntimeStores,
) -> Result<MemorySync, BtccError> {
    match result {
        Ok(owner) => Ok(owner),
        Err(error) => {
            let _ = observer.close().await;
            let _ = work_streams.close().await;
            let _ = stores.close().await;
            Err(error)
        }
    }
}

pub(super) fn setup(error: impl std::error::Error + Send + Sync + 'static) -> BtccError {
    BtccError::relayed("native_runtime_initialization_failed", error.to_string()).with_source(error)
}

pub(super) fn validate_data_installation_boundary(
    data_root: &Path,
    installation_root: &Path,
) -> Result<(), BtccError> {
    let data_root = data_root.canonicalize().map_err(setup)?;
    let installation_root = installation_root.canonicalize().map_err(setup)?;
    if data_root.starts_with(&installation_root) || installation_root.starts_with(&data_root) {
        return Err(BtccError::relayed(
            "native_path_configuration_invalid",
            "DATA overlaps the native installation.",
        ));
    }
    Ok(())
}
