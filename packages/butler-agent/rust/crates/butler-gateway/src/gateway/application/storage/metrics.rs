//! Storage instrumentation is opt-in and writes no transcript content.
use super::{AppStorageError, StorageResult};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

#[derive(Default)]
pub(in crate::gateway::application) struct Metrics {
    pub(in crate::gateway::application) commits: AtomicU64,
    operations: Mutex<Vec<u64>>,
    busy: AtomicU64,
}
impl Metrics {
    pub(super) fn operation(&self, elapsed: Duration) {
        if enabled() {
            self.operations
                .lock()
                .push(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX));
        }
    }
    pub(super) fn busy(&self) {
        self.busy.fetch_add(1, Ordering::Relaxed);
    }
    pub(super) fn save(&self, database: &Path) -> StorageResult<()> {
        if !enabled() {
            return Ok(());
        }
        let wal = database.with_file_name(format!(
            "{}-wal",
            database.file_name().unwrap_or_default().to_string_lossy()
        ));
        let bytes = std::fs::metadata(wal).map_or(0, |value| value.len());
        let operations = self.operations.lock();
        let bounds = [
            100,
            250,
            500,
            1_000,
            2_000,
            5_000,
            10_000,
            20_000,
            100_000,
            u64::MAX,
        ];
        let mut histogram = vec![0_u64; bounds.len()];
        for sample in operations.iter() {
            if let Some(index) = bounds.iter().position(|bound| sample <= bound) {
                histogram[index] += 1;
            }
        }
        let value = serde_json::json!({"commits":self.commits.load(Ordering::Relaxed),"wal_bytes":bytes,"busy":self.busy.load(Ordering::Relaxed),"operation_us":*operations,"histogram_upper_us":bounds,"histogram_counts":histogram});
        std::fs::write(database.with_extension("metrics.json"), value.to_string()).map_err(
            |error| {
                AppStorageError::new(
                    super::AppStorageCode::AppSqliteParentCreateFailed,
                    error.to_string(),
                )
            },
        )
    }
}
pub(in crate::gateway::application) fn baseline() -> bool {
    matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var_os("BUTLER_E2E_STORAGE_BASELINE").is_some()
}
fn enabled() -> bool {
    matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var_os("BUTLER_E2E_STORAGE_METRICS").is_some()
}
pub(super) fn configure(db: &Connection) -> StorageResult<()> {
    if enabled() {
        db.pragma_update(None, "wal_autocheckpoint", 0)
            .map_err(AppStorageError::sqlite)?;
    }
    Ok(())
}
