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

type SessionUsageServices = (
    Arc<butler_turn::btcc::SubsessionService>,
    Arc<butler_runtime::operations::UsageLineage>,
    Arc<butler_gateway::gateway::InboundQueue>,
);

/// Compose the two owners from the same durable relation repository.
pub(super) fn session_usage_services(
    stores: &super::stores::RuntimeStores,
    data_root: &Path,
    (profiles, endpoint): (
        Arc<dyn butler_turn::btcc::WorkerProfileReader>,
        Arc<crate::host::ActiveAppEndpoint>,
    ),
    work: Arc<butler_turn::btcc::DurableWorkService>,
    cutover: &super::work_cutover::CutoverOwner,
) -> Result<SessionUsageServices, butler_turn::btcc::BtccError> {
    let queue = Arc::new(butler_gateway::gateway::InboundQueue::new(data_root));
    let repository = butler_turn::btcc::SqliteSubsessionRepository::new(stores.btcc.clone());
    let lineage = Arc::new(butler_runtime::operations::UsageLineage::new(
        repository.clone(),
    ));
    let subsessions = Arc::new(butler_turn::btcc::SubsessionService::new(
        repository,
        stores.bindings.clone(),
        Arc::new(super::subsession_queue::AppSubsessionQueue::new(
            queue.clone(),
            endpoint,
        )?),
        profiles,
        work,
        Arc::new(|| {
            butler_models::models::ModelConfigurationClock::now_iso(&super::SystemIdentity)
        }),
    ));
    cutover.bind_subsessions(subsessions.clone());
    Ok((subsessions, lineage, queue))
}
