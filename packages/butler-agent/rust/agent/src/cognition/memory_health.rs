//! Read-only source-compatible memory health summary for consolidation metrics.

mod maintenance;
mod serving;
mod sources;

#[cfg(test)]
#[path = "memory_health/tests.rs"]
mod tests;

use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::CognitionWriteCoordinator,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MaintenanceStatus {
    Missing,
    Ok,
    Stale,
    Failed,
    Repaired,
}

impl MaintenanceStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Ok => "ok",
            Self::Stale => "stale",
            Self::Failed => "failed",
            Self::Repaired => "repaired",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct MemoryHealthReport {
    pub memory_chunks_count: i64,
    pub vector_rows_count: Option<f64>,
    pub maintenance_status: MaintenanceStatus,
    pub diagnostics_count: usize,
    pub metric_dimensions: Value,
    pub metric_status: &'static str,
    pub summary: Value,
}

pub(crate) struct MemoryHealthService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl MemoryHealthService {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
    ) -> Self {
        Self {
            data_root,
            paths,
            coordinator,
        }
    }

    pub(crate) async fn read(&self) -> CognitionResult<MemoryHealthReport> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        self.read_at(now).await
    }

    pub(crate) async fn read_at(&self, now_epoch_ms: i64) -> CognitionResult<MemoryHealthReport> {
        self.read_at_with_profile(now_epoch_ms, None).await
    }

    pub(crate) async fn read_tool(&self, profile: Value) -> CognitionResult<MemoryHealthReport> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        self.read_at_with_profile(now, Some(profile)).await
    }

    async fn read_at_with_profile(
        &self,
        now_epoch_ms: i64,
        profile: Option<Value>,
    ) -> CognitionResult<MemoryHealthReport> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            sources::read(&data_root, &paths, &coordinator, now_epoch_ms, profile)
        })
        .await
        .map_err(|_| error("memory_health_read_failed"))?
    }
}

fn error(code: &'static str) -> CognitionError {
    CognitionError::new(code, "Could not read Cognition memory health")
}
