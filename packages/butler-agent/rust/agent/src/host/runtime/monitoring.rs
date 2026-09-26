use std::{path::Path, sync::Arc};

use crate::{
    cognition::{CognitionPathEnvironment, MemoryHealthService},
    coordination::CognitionWriteCoordinator,
    operations::{CycleMetrics, MetricFiles},
    profile::ProfileService,
};

use super::super::{MonitoringReaders, NativeProcessModels};

pub(super) fn open(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    models: &NativeProcessModels,
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
