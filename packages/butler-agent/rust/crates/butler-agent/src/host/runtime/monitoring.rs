use std::{path::Path, sync::Arc};

use crate::cognition::CognitionPathEnvironment;
use crate::cognition::MemoryHealthService;
use crate::coordination::CognitionWriteCoordinator;
use crate::profile::ProfileService;
use butler_runtime::operations::CycleMetrics;
use butler_runtime::operations::MetricFiles;

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
