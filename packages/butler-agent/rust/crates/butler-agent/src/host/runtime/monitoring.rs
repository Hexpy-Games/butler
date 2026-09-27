use std::{path::Path, sync::Arc};

use butler_memory::cognition::{CognitionPathEnvironment, MemoryHealthService};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_memory::profile::ProfileService;
use butler_runtime::operations::{CycleMetrics, MetricFiles};

use super::super::{MonitoringReaders, ProcessModels};

pub(super) fn open(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    models: &ProcessModels,
    coordinator: Arc<CognitionWriteCoordinator>,
    profile: Arc<ProfileService>,
    metrics: Arc<MetricFiles>,
) -> Arc<MonitoringReaders> {
    Arc::new(MonitoringReaders::new(
        data_root.to_owned(),
        models.configuration.clone(),
        models.catalog.clone(),
        Arc::new(MemoryHealthService::new(
            data_root.to_owned(),
            paths.clone(),
            coordinator,
        )),
        profile,
        Arc::new(CycleMetrics::new(metrics)),
    ))
}
