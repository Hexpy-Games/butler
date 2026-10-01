use butler_platform::secure_fs::Canonical as _;
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
    let data_root = data_root.canonical().map_err(setup)?;
    let installation_root = installation_root.canonical().map_err(setup)?;
    if data_root.starts_with(&installation_root) || installation_root.starts_with(&data_root) {
        return Err(BtccError::relayed(
            "native_path_configuration_invalid",
            "DATA overlaps the native installation.",
        ));
    }
    Ok(())
}

/// Partial startup owners must be closed if either memory setup or a stop fails the phase.
pub(super) struct MemoryStartup<'a> {
    pub observer: &'a Arc<ConversationObserver>,
    pub work_streams: &'a Arc<WorkStreams>,
    pub stores: &'a RuntimeStores,
    pub stop: &'a tokio_util::sync::CancellationToken,
}

impl MemoryStartup<'_> {
    pub(super) async fn open(
        &self,
        paths: &super::RuntimePaths,
        cognition_paths: &butler_memory::cognition::CognitionPathEnvironment,
        coordinator: Arc<butler_memory::coordination::CognitionWriteCoordinator>,
        provider: Arc<butler_models::models::ModelProvider>,
        embedding: Arc<crate::host::EmbeddingOwner>,
        vector: Arc<butler_memory::cognition::GenerationVectorAdapter>,
    ) -> Result<MemorySync, BtccError> {
        let opened = super::stores::check_startup(self.stop).and_then(|()| {
            MemorySync::open(
                &paths.data_root,
                cognition_paths,
                coordinator,
                provider,
                paths.unclean_previous_exit,
                embedding,
                vector,
            )
        });
        let owner =
            close_after_memory_sync_error(opened, self.observer, self.work_streams, self.stores)
                .await?;
        check_memory_startup(
            self.stop,
            &owner,
            self.observer,
            self.work_streams,
            self.stores,
        )
        .await?;
        Ok(owner)
    }
}

pub(super) async fn check_memory_startup(
    stop: &tokio_util::sync::CancellationToken,
    memory_sync: &MemorySync,
    observer: &Arc<ConversationObserver>,
    work_streams: &Arc<WorkStreams>,
    stores: &RuntimeStores,
) -> Result<(), BtccError> {
    if let Err(error) = super::stores::check_startup(stop) {
        let _ = memory_sync.close().await;
        let _ = observer.close().await;
        let _ = work_streams.close().await;
        let _ = stores.close().await;
        return Err(error);
    }
    Ok(())
}

/// Open observer producers together; neither may outlive a failed startup phase.
pub(super) async fn open_observer(
    data_root: &Path,
    cognition_paths: &butler_memory::cognition::CognitionPathEnvironment,
    metric_files: Arc<butler_runtime::operations::MetricFiles>,
    stores: &RuntimeStores,
) -> Result<(Arc<WorkStreams>, Arc<ConversationObserver>), BtccError> {
    let work_streams = match WorkStreams::open(data_root.to_owned()) {
        Ok(owner) => Arc::new(owner),
        Err(error) => {
            let _ = stores.close().await;
            return Err(error);
        }
    };
    let observer = match ConversationObserver::new(
        data_root,
        cognition_paths,
        Arc::new(crate::host::SystemIdentity),
        metric_files.clone(),
    ) {
        Ok(observer) => Arc::new(observer),
        Err(error) => {
            let _ = work_streams.close().await;
            let _ = stores.close().await;
            return Err(setup(error));
        }
    };
    Ok((work_streams, observer))
}
