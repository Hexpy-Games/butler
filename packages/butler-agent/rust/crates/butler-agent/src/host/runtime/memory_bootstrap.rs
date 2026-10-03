//! Fresh memory bootstrap before store producers or background consumers open.
use super::{RuntimePaths, setup};
use crate::host::{EmbeddingOwner, SystemIdentity};
use butler_core::locale::LocaleCollation;
use butler_memory::cognition::{
    CognitionPathEnvironment, FreshMemoryGeneration, GenerationVectorAdapter,
    prepare_fresh_memory_generation,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::ModelConfigurationClock;
use butler_turn::btcc::BtccError;
use std::sync::Arc;

pub(super) async fn open(
    paths: &RuntimePaths,
    cognition_paths: &CognitionPathEnvironment,
) -> Result<
    (
        Arc<CognitionWriteCoordinator>,
        Arc<EmbeddingOwner>,
        Arc<GenerationVectorAdapter>,
        Option<FreshMemoryGeneration>,
    ),
    BtccError,
> {
    let coordinator =
        Arc::new(CognitionWriteCoordinator::new(Arc::new(SystemIdentity)).map_err(setup)?);
    let root = paths.data_root.clone();
    let supported = tokio::task::spawn_blocking(move || {
        !super::storage_bootstrap::is_unsupported_legacy_data(&root)
    })
    .await
    .map_err(setup)?;
    // Preserve the existing storage bootstrap's no-write refusal for old App data.
    let fresh = if supported {
        let (major, minor, patch) = unicode_normalization::UNICODE_VERSION;
        prepare_fresh_memory_generation(
            paths.data_root.clone(),
            cognition_paths.clone(),
            coordinator.clone(),
            Arc::new(|| SystemIdentity.now_iso()),
            format!("{major}.{minor}.{patch}"),
            LocaleCollation::implementation_version().into(),
        )
        .await
        .map_err(setup)?
    } else {
        None
    };
    let embedding = Arc::new(EmbeddingOwner::new(paths.data_root.clone()).map_err(setup)?);
    let vectors = Arc::new(GenerationVectorAdapter::new(
        paths.data_root.clone(),
        cognition_paths.clone(),
        embedding.clone(),
    ));
    Ok((coordinator, embedding, vectors, fresh))
}

/// Compose the rule owner and request targeted recovery without delaying admission.
pub(super) fn rule_owner(
    paths: &RuntimePaths,
    environment: &CognitionPathEnvironment,
    coordinator: &Arc<CognitionWriteCoordinator>,
    stop: &tokio_util::sync::CancellationToken,
) -> crate::host::guided::tools::MemoryWriteServices {
    let services = crate::host::guided::tools::MemoryWriteServices::new(
        &paths.data_root,
        environment,
        coordinator.clone(),
        Arc::new(|| SystemIdentity.now_iso()),
    );
    services.recover_at_startup(stop.clone());
    services
}
