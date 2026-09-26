//! Operations-owned append and retention for the fixed metric files.

use parking_lot::{Mutex, MutexGuard};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::context::{
    CompactionMetricEvent, ContextCompactionMetricSink, ContextError, ContextResult,
    PruneMetricObserver, PruneToolOutputResult,
};

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
/// Clones share four fixed locks. Appends and retention therefore serialize for
/// the same file without coordinating unrelated files or using a global table.
#[derive(Clone)]
pub(crate) struct MetricFiles {
    data_root: PathBuf,
    locks: [Arc<Mutex<()>>; 4],
}

impl MetricFiles {
    pub(crate) fn new(data_root: PathBuf) -> Self {
        Self {
            data_root,
            locks: std::array::from_fn(|_| Arc::new(Mutex::new(()))),
        }
    }

    pub(crate) fn data_root(&self) -> &Path {
        &self.data_root
    }

    pub(crate) fn append(&self, file: MetricFile, bytes: &[u8]) -> io::Result<()> {
        let _guard = self.lock(file);
        let directory = self.metric_directory();
        fs::create_dir_all(&directory)?;
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join(file.file_name()))?;
        output.write_all(bytes)
    }

    pub(crate) fn append_operational_event(&self, bytes: &[u8]) -> io::Result<()> {
        self.append(MetricFile::OperationalEvents, bytes)
    }

    pub(crate) fn retain(&self, now_ms: f64, max_age_ms: f64) -> io::Result<MetricRetentionResult> {
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
        let _guard = self.lock(file);
        let path = self.metric_directory().join(file.file_name());
        let source = match File::open(&path) {
            Ok(source) => source,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(MetricRetentionStats::default());
            }
            Err(error) => return Err(error),
        };
        let source_permissions = source.metadata()?.permissions();

        let temporary_path = temporary_path(&path);
        let output = open_private_temporary(&temporary_path)?;
        let mut cleanup = TemporaryPath::new(temporary_path.clone());
        let mut reader = BufReader::new(source);
        let mut writer = BufWriter::new(output);
        let threshold = now_ms - max_age_ms;
        let mut stats = MetricRetentionStats::default();
        let mut record = Vec::new();

        loop {
            record.clear();
            if reader.read_until(b'\n', &mut record)? == 0 {
                break;
            }
            if is_blank_record(&record) {
                continue;
            }

            stats.scanned += 1;
            let mut value = match serde_json::from_slice::<Value>(&record) {
                Ok(value) => value,
                Err(_) => {
                    stats.parse_errors += 1;
                    continue;
                }
            };
            let timestamp = value
                .get("ts")
                .and_then(Value::as_f64)
                .filter(|timestamp| timestamp.is_finite());
            let Some(timestamp) = timestamp else {
                stats.parse_errors += 1;
                continue;
            };
            if timestamp < threshold {
                stats.deleted += 1;
                continue;
            }

            let Some(object) = value.as_object_mut() else {
                stats.parse_errors += 1;
                continue;
            };
            object.insert("rawTextStored".into(), Value::Bool(false));
            serde_json::to_writer(&mut writer, &value).map_err(json_write_error)?;
            writer.write_all(b"\n")?;
            stats.kept += 1;
        }

        writer.flush()?;
        writer.get_ref().sync_all()?;
        drop(writer);
        fs::set_permissions(&temporary_path, source_permissions)?;
        fs::rename(&temporary_path, &path)?;
        cleanup.commit();
        Ok(stats)
    }

    fn lock(&self, file: MetricFile) -> MutexGuard<'_, ()> {
        self.locks[file.index()].lock()
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
        let mut line = serde_json::to_vec(&event)
            .map_err(|error| ContextError::new("tool_output_json_error", error.to_string()))?;
        line.push(b'\n');
        self.append(MetricFile::ToolOutputPrune, &line)
            .map_err(|error| ContextError::new("tool_output_io_error", error.to_string()))
    }
}

impl ContextCompactionMetricSink for MetricFiles {
    fn append_context_compaction_metric(&self, event: &CompactionMetricEvent) -> ContextResult<()> {
        let mut line = serde_json::to_vec(event)
            .map_err(|error| ContextError::new("context_metric_write_error", error.to_string()))?;
        line.push(b'\n');
        self.append(MetricFile::ContextCompaction, &line)
            .map_err(|error| ContextError::new("context_metric_write_error", error.to_string()))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct MetricRetentionStats {
    pub(crate) scanned: usize,
    pub(crate) kept: usize,
    pub(crate) deleted: usize,
    pub(crate) parse_errors: usize,
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
pub(crate) struct MetricRetentionResult {
    pub(crate) files: [MetricFileRetentionResult; 4],
    pub(crate) totals: MetricRetentionStats,
}

#[cfg(test)]
impl MetricRetentionResult {
    pub(crate) fn for_file(&self, file: MetricFile) -> &MetricFileRetentionResult {
        &self.files[file.index()]
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .expect("fixed metric paths have file names")
        .to_string_lossy();
    path.with_file_name(format!(".{name}.retain-{}.tmp", uuid::Uuid::new_v4()))
}

fn open_private_temporary(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
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

fn json_write_error(error: serde_json::Error) -> io::Error {
    io::Error::other(error.to_string())
}

fn is_blank_record(record: &[u8]) -> bool {
    std::str::from_utf8(record).is_ok_and(|text| text.trim().is_empty())
}

#[cfg(test)]
mod tests;
