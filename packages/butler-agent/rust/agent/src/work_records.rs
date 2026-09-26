//! Original planned-task records, distinct from authoritative BTCC Work.
//!
//! Reads run inside the calling operation's owned blocking scope. This facade
//! retains only the bound data root; no transcript/report cache or writer exists.

mod dashboard;
mod memory_projection;
mod memory_report;
mod read;

pub(crate) use memory_projection::TaskMemoryProjection;
pub(crate) use memory_report::PlannedTaskMemoryReport;
pub(crate) use read::{ReadAvailability, WorkRecordReadError};

use std::path::{Path, PathBuf};

use crate::locale::LocaleCollation;
use serde_json::Value;

#[derive(Clone)]
pub(crate) struct WorkRecordReader {
    tasks: PathBuf,
}

impl WorkRecordReader {
    pub(crate) fn new(butler_data: &Path) -> Self {
        Self {
            tasks: butler_data.join("tasks"),
        }
    }

    pub(crate) fn dashboard(
        &self,
        debug: bool,
        limit: Option<f64>,
        collation: &LocaleCollation,
    ) -> Result<Value, WorkRecordReadError> {
        dashboard::project(&self.tasks, debug, limit, collation)
    }

    pub(crate) fn cli_task_summaries(
        &self,
        status: Option<&str>,
        collation: &LocaleCollation,
    ) -> Result<Vec<Value>, WorkRecordReadError> {
        dashboard::cli_summaries(&self.tasks, status, collation)
    }

    pub(crate) fn cli_task_summary(
        &self,
        task_id: &str,
    ) -> Result<Option<Value>, WorkRecordReadError> {
        if !self
            .task_ids()?
            .iter()
            .any(|candidate| candidate == task_id)
        {
            return Ok(None);
        }
        dashboard::cli_summary_by_id(&self.tasks, task_id)
    }

    pub(crate) fn read_memory_report(
        &self,
        task_id: &str,
        availability: ReadAvailability,
    ) -> Result<Option<PlannedTaskMemoryReport>, WorkRecordReadError> {
        let directory = self.tasks.join(task_id);
        if !directory.exists() {
            return Ok(None);
        }
        Ok(memory_report::read(&directory, availability)?
            .filter(|report| report.task_id == task_id))
    }

    pub(crate) fn task_memory_projection(
        &self,
        task_id: &str,
    ) -> Result<Option<TaskMemoryProjection>, WorkRecordReadError> {
        memory_projection::read(self, task_id)
    }

    pub(crate) fn has_planned_task(&self, task_id: &str) -> Result<bool, WorkRecordReadError> {
        Ok(read::snapshot(&self.tasks.join(task_id), ReadAvailability::BestEffort)?.is_some())
    }

    pub(crate) fn task_ids(&self) -> Result<Vec<String>, WorkRecordReadError> {
        if !self.tasks.exists() {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(&self.tasks)? {
            let entry = entry?;
            if entry.path().join("status").exists() {
                ids.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        // TaskStore.taskIds uses the filesystem's readdir order. Consumers
        // that need lexicographic order sort explicitly at their source point.
        Ok(ids)
    }
}

pub(crate) fn task_memory_record_id(task_id: &str) -> String {
    use base64::Engine;
    format!(
        "task-report.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(task_id)
    )
}

pub(crate) fn task_id_from_memory_record_id(record_id: &str) -> Option<String> {
    use base64::Engine;
    let encoded = record_id.strip_prefix("task-report.")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    let task_id = String::from_utf8_lossy(&bytes).into_owned();
    (!task_id.is_empty() && task_memory_record_id(&task_id) == record_id).then_some(task_id)
}

#[cfg(test)]
mod tests;
