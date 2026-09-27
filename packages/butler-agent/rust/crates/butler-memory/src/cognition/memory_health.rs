//! Read-only source-compatible memory health summary for consolidation metrics.
//!
//! [`MemoryHealthService`] gathers the legacy stores, the last maintenance
//! run (`maintenance`), the writer lock and the serving generation
//! (`serving`) into a [`MemoryHealthReport`] (`sources`, typed in `report`).

mod maintenance;
mod report;
mod serving;
mod sources;

#[cfg(test)]
mod format_pin;
#[cfg(test)]
mod tests;

use crate::cognition::CognitionCode;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::profile::ProfileCoverageHealth;
use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, CognitionResult},
    coordination::CognitionWriteCoordinator,
};

/// State of the consolidation maintenance runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaintenanceStatus {
    /// No maintenance run was recorded.
    Missing,
    /// The last run succeeded.
    Ok,
    /// The last run is too old.
    Stale,
    /// The last run failed.
    Failed,
    /// The last run succeeded after a failed one.
    Repaired,
}

impl MaintenanceStatus {
    /// The status name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Ok => "ok",
            Self::Stale => "stale",
            Self::Failed => "failed",
            Self::Repaired => "repaired",
        }
    }
}

/// A memory health reading.
#[derive(Clone, Debug)]
pub struct MemoryHealthReport {
    /// Legacy memory chunks.
    pub memory_chunks_count: i64,
    /// Legacy vector rows, when a vector snapshot exists.
    pub vector_rows_count: Option<f64>,
    /// State of the maintenance runs.
    pub maintenance_status: MaintenanceStatus,
    /// Number of diagnostics in the summary.
    pub diagnostics_count: usize,
    dimensions: report::HealthDimensions,
    /// `error` when maintenance failed, else `ok`.
    pub metric_status: &'static str,
    summary: report::HealthSummary,
}

impl MemoryHealthReport {
    /// The dimensions to record with the `health` metric, as JSON.
    pub fn metric_dimensions(&self) -> Value {
        serde_json::to_value(&self.dimensions).unwrap_or(Value::Null)
    }

    /// The operator summary (the `memory_health` tool result), as JSON.
    pub fn summary(&self) -> Value {
        serde_json::to_value(&self.summary).unwrap_or(Value::Null)
    }
}

/// Reads memory health without taking the writer lock.
pub struct MemoryHealthService {
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl MemoryHealthService {
    /// A health reader over `data_root`.
    pub fn new(
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

    /// Health at the current time, without profile coverage.
    pub async fn read(&self) -> CognitionResult<MemoryHealthReport> {
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(i64::MAX as u128),
        )
        .unwrap_or(i64::MAX);
        self.read_at(now).await
    }

    pub(crate) async fn read_at(&self, now_epoch_ms: i64) -> CognitionResult<MemoryHealthReport> {
        self.read_at_with_profile(now_epoch_ms, None).await
    }

    /// Health at the current time, including the profile's coverage.
    pub async fn read_tool(
        &self,
        profile: ProfileCoverageHealth,
    ) -> CognitionResult<MemoryHealthReport> {
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(i64::MAX as u128),
        )
        .unwrap_or(i64::MAX);
        self.read_at_with_profile(now, Some(profile)).await
    }

    async fn read_at_with_profile(
        &self,
        now_epoch_ms: i64,
        profile: Option<ProfileCoverageHealth>,
    ) -> CognitionResult<MemoryHealthReport> {
        let data_root = self.data_root.clone();
        let paths = self.paths.clone();
        let coordinator = self.coordinator.clone();
        tokio::task::spawn_blocking(move || {
            sources::read(
                &data_root,
                &paths,
                &coordinator,
                now_epoch_ms,
                profile.as_ref(),
            )
        })
        .await
        .map_err(|source| error(CognitionCode::MemoryHealthReadFailed).with_source(source))?
    }
}

fn error(code: CognitionCode) -> CognitionError {
    CognitionError::new(code, "Could not read Cognition memory health")
}
