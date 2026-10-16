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
    view_phases: Mutex<std::collections::BTreeMap<&'static str, Vec<u64>>>,
    slow_views: Mutex<Vec<(&'static str, u128, u128)>>,
    write_phases: Mutex<std::collections::BTreeMap<&'static str, Vec<u64>>>,
    busy: AtomicU64,
    page_size: AtomicU64,
}
pub(in crate::gateway::application) struct ViewMeasurement {
    metrics: std::sync::Arc<Metrics>,
    name: &'static str,
    start: std::time::Instant,
    unix_us: u128,
}
impl Drop for ViewMeasurement {
    fn drop(&mut self) {
        let elapsed = self.start.elapsed();
        self.metrics.view_phase(self.name, elapsed);
        if elapsed.as_micros() > 20_000 {
            self.metrics
                .slow_views
                .lock()
                .push((self.name, self.unix_us, elapsed.as_micros()));
        }
    }
}
pub(super) fn view_measurement(
    metrics: std::sync::Arc<Metrics>,
    name: &'static str,
) -> Option<ViewMeasurement> {
    enabled().then(|| ViewMeasurement {
        metrics,
        name,
        start: std::time::Instant::now(),
        unix_us: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros(),
    })
}

impl Metrics {
    pub(super) fn operation(&self, elapsed: Duration) {
        if enabled() {
            self.operations
                .lock()
                .push(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX));
        }
    }
    pub(super) fn view_phase(&self, name: &'static str, elapsed: Duration) {
        if enabled() {
            self.view_phases
                .lock()
                .entry(name)
                .or_default()
                .push(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX));
        }
    }
    pub(super) fn write_phase(&self, name: &'static str, elapsed: Duration) {
        if enabled() {
            self.write_phases
                .lock()
                .entry(name)
                .or_default()
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
        // WAL bytes written: header plus every appended frame (page + 24-byte header).
        let frames = WAL_FRAMES.with(|cell| cell.get().1);
        let bytes = 32 + frames * (self.page_size.load(Ordering::Relaxed) + 24);
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
        let value = serde_json::json!({"commits":self.commits.load(Ordering::Relaxed),"wal_bytes":bytes,"busy":self.busy.load(Ordering::Relaxed),"operation_us":*operations,"view_phase_us":*self.view_phases.lock(),"view_slow":*self.slow_views.lock(),"write_phase_us":*self.write_phases.lock(),"histogram_upper_us":bounds,"histogram_counts":histogram});
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
pub(super) fn enabled() -> bool {
    matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var_os("BUTLER_E2E_STORAGE_METRICS").is_some()
}
/// Records the writer's page size; the WAL keeps its ordinary checkpoints.
pub(super) fn configure(metrics: &Metrics, db: &Connection) -> StorageResult<()> {
    if enabled() {
        let page_size: u64 = db
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .map_err(AppStorageError::sqlite)?;
        metrics.page_size.store(page_size, Ordering::Relaxed);
    }
    Ok(())
}

thread_local! {
    /// `(frames in the current WAL, frames written)` on this writer thread.
    static WAL_FRAMES: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
}

/// Counts the frames a writer commit appended, across WAL restarts. SQLite
/// reports the frames now in the WAL; a smaller count means it restarted.
pub(super) fn wal_committed(frames: i32) {
    if !enabled() {
        return;
    }
    let frames = u64::try_from(frames).unwrap_or_default();
    WAL_FRAMES.with(|cell| {
        let (current, written) = cell.get();
        let appended = frames.checked_sub(current).unwrap_or(frames);
        cell.set((frames, written + appended));
    });
}
