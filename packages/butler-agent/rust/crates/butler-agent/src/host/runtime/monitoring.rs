use std::{path::Path, sync::Arc};

use butler_memory::cognition::{CognitionPathEnvironment, MemoryHealthService};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_memory::profile::ProfileService;
use butler_runtime::operations::{CycleMetrics, MetricFiles};

use super::super::{MonitoringReaders, ProcessModels};

pub(super) fn open(
    (data_root, app_database_path): (&Path, &Path),
    paths: &CognitionPathEnvironment,
    models: &ProcessModels,
    coordinator: Arc<CognitionWriteCoordinator>,
    profile: Arc<ProfileService>,
    metrics: Arc<MetricFiles>,
    lineage: Arc<butler_runtime::operations::UsageLineage>,
) -> Arc<MonitoringReaders> {
    Arc::new(MonitoringReaders::new(
        (data_root.to_owned(), app_database_path.to_owned()),
        models.configuration.clone(),
        models.catalog.clone(),
        Arc::new(MemoryHealthService::new(
            data_root.to_owned(),
            paths.clone(),
            coordinator,
        )),
        profile,
        Arc::new(CycleMetrics::new(metrics)),
        lineage,
    ))
}

/// Compose the two owners from the same durable relation repository.
pub(super) fn session_usage_services(
    repository: butler_turn::btcc::SqliteSubsessionRepository,
    bindings: butler_turn::workspace::SessionBindingStore,
    queue: Arc<butler_gateway::gateway::InboundQueue>,
    profiles: Arc<dyn butler_turn::btcc::WorkerProfileReader>,
    work: Arc<butler_turn::btcc::DurableWorkService>,
) -> (
    Arc<butler_turn::btcc::SubsessionService>,
    Arc<butler_runtime::operations::UsageLineage>,
) {
    let lineage = Arc::new(butler_runtime::operations::UsageLineage::new(
        repository.clone(),
    ));
    let subsessions = Arc::new(butler_turn::btcc::SubsessionService::new(
        repository,
        bindings,
        Arc::new(super::SubsessionQueue(queue)),
        profiles,
        work,
        Arc::new(|| {
            butler_models::models::ModelConfigurationClock::now_iso(&super::SystemIdentity)
        }),
    ));
    (subsessions, lineage)
}
