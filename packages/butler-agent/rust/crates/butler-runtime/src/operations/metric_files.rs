//! Operations-owned append and retention for the fixed metric files.

use parking_lot::Mutex;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::context::ContextCode;
use crate::context::{
    CompactionMetricEvent, ContextCompactionMetricSink, ContextError, ContextResult,
    PruneMetricObserver, PruneToolOutputResult,
};

mod retention;

const METRIC_FILES: [MetricFile; 4] = [
    MetricFile::ContextMonitor,
    MetricFile::ContextCompaction,
    MetricFile::ToolOutputPrune,
    MetricFile::OperationalEvents,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MetricFile {
    ContextMonitor,
    ContextCompaction,
    ToolOutputPrune,
    OperationalEvents,
}

impl MetricFile {
    fn index(self) -> usize {
        match self {
            Self::ContextMonitor => 0,
            Self::ContextCompaction => 1,
            Self::ToolOutputPrune => 2,
            Self::OperationalEvents => 3,
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::ContextMonitor => "context-monitor.jsonl",
            Self::ContextCompaction => "context-compaction.jsonl",
            Self::ToolOutputPrune => "tool-output-prune.jsonl",
            Self::OperationalEvents => "operational-events.jsonl",
        }
    }
}

/// Shared per-runtime access to the fixed Operations metric files.
///
/// Stable sidecar locks coordinate independent instances and processes. Retention
/// streams outside the append lock, then verifies EOF and publishes under it.
/// Call these synchronous file operations from blocking workers.
#[derive(Clone)]
pub struct MetricFiles {
    data_root: PathBuf,
    retention: [Arc<Mutex<Option<retention::Snapshot>>>; 4],
}

impl MetricFiles {
    pub fn new(data_root: PathBuf) -> Self {
        Self {
            data_root,
            retention: std::array::from_fn(|_| Arc::new(Mutex::new(None))),
        }
    }

    pub fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub(crate) fn append(&self, file: MetricFile, bytes: &[u8]) -> io::Result<()> {
        let _guard = self.file_lock(file, "append")?;
        let directory = self.metric_directory();
        fs::create_dir_all(&directory)?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        butler_platform::secure_fs::owner_only(&mut options);
        butler_platform::secure_fs::no_follow(&mut options);
        let mut output = options.open(directory.join(file.file_name()))?;
        butler_platform::secure_fs::restrict_open_file(&output).unwrap_or(Ok(()))?;
        output.write_all(bytes)
    }

    pub fn append_operational_event(&self, bytes: &[u8]) -> io::Result<()> {
        self.append(MetricFile::OperationalEvents, bytes)
    }

    pub fn retain(&self, now_ms: f64, max_age_ms: f64) -> io::Result<MetricRetentionResult> {
        let mut files = std::array::from_fn(|index| MetricFileRetentionResult {
            file: METRIC_FILES[index],
            stats: MetricRetentionStats::default(),
        });
        let mut totals = MetricRetentionStats::default();

        for file in METRIC_FILES {
            let stats = self.retain_file(file, now_ms, max_age_ms)?;
            totals.add_assign(stats);
            files[file.index()].stats = stats;
        }

        Ok(MetricRetentionResult { files, totals })
    }

    fn retain_file(
        &self,
        file: MetricFile,
        now_ms: f64,
        max_age_ms: f64,
    ) -> io::Result<MetricRetentionStats> {
        let mut snapshot = self.retention[file.index()].lock();
        retention::retain(self, file, now_ms - max_age_ms, &mut snapshot)
    }

    fn file_lock(
        &self,
        file: MetricFile,
        lane: &str,
    ) -> io::Result<butler_platform::instance::InstanceLock> {
        let directory = self.metric_directory();
        butler_platform::secure_fs::create_private_dir_all(&directory)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        butler_platform::secure_fs::owner_only(&mut options);
        butler_platform::secure_fs::no_follow(&mut options);
        let lock = options.open(directory.join(format!(".{}.{lane}.lock", file.file_name())))?;
        butler_platform::secure_fs::restrict_open_file(&lock).unwrap_or(Ok(()))?;
        butler_platform::instance::InstanceLock::exclusive(lock)
    }

    fn metric_directory(&self) -> PathBuf {
        self.data_root.join("metrics")
    }
}

impl PruneMetricObserver for MetricFiles {
    fn observe_prune(
        &self,
        now_ms: f64,
        result: &PruneToolOutputResult,
        protected_count: usize,
    ) -> ContextResult<()> {
        let event = json!({
            "schema": "butler.tool-output-prune.v1", "ts": now_ms,
            "scanned": result.scanned, "deleted": result.deleted,
            "bytesDeleted": result.bytes_deleted, "remainingBytes": result.remaining_bytes,
            "maxAgeMs": result.max_age_ms, "maxBytes": result.max_bytes,
            "protectedCount": protected_count, "rawTextStored": false,
        });
        let mut line = serde_json::to_vec(&event).map_err(|error| {
            ContextError::new(ContextCode::ToolOutputJsonError, error.to_string())
                .with_source(error)
        })?;
        line.push(b'\n');
        self.append(MetricFile::ToolOutputPrune, &line)
            .map_err(|error| {
                ContextError::new(ContextCode::ToolOutputIoError, error.to_string())
                    .with_source(error)
            })
    }
}

impl ContextCompactionMetricSink for MetricFiles {
    fn append_context_compaction_metric(&self, event: &CompactionMetricEvent) -> ContextResult<()> {
        let mut line = serde_json::to_vec(event).map_err(|error| {
            ContextError::new(ContextCode::ContextMetricWriteError, error.to_string())
                .with_source(error)
        })?;
        line.push(b'\n');
        self.append(MetricFile::ContextCompaction, &line)
            .map_err(|error| {
                ContextError::new(ContextCode::ContextMetricWriteError, error.to_string())
                    .with_source(error)
            })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MetricRetentionStats {
    pub scanned: usize,
    pub kept: usize,
    pub deleted: usize,
    pub parse_errors: usize,
}

impl MetricRetentionStats {
    fn add_assign(&mut self, other: Self) {
        self.scanned += other.scanned;
        self.kept += other.kept;
        self.deleted += other.deleted;
        self.parse_errors += other.parse_errors;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MetricFileRetentionResult {
    pub(crate) file: MetricFile,
    pub(crate) stats: MetricRetentionStats,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetricRetentionResult {
    pub(crate) files: [MetricFileRetentionResult; 4],
    pub totals: MetricRetentionStats,
}

#[cfg(any(test, feature = "test-support"))]
impl MetricRetentionResult {
    pub(crate) fn for_file(&self, file: MetricFile) -> &MetricFileRetentionResult {
        &self.files[file.index()]
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.retain-{}.tmp", uuid::Uuid::new_v4()))
}

fn open_private_temporary(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    butler_platform::secure_fs::owner_only(&mut options);
    options.open(path)
}

struct TemporaryPath {
    path: PathBuf,
    committed: bool,
}

impl TemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests;
