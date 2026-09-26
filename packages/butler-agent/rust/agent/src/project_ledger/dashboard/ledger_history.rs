use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::Path;

use serde_json::Value;

use crate::project_ledger::ProjectLedgerReadError;

const MAX_HISTORY_BYTES: u64 = 32 * 1024 * 1024;
const MAX_HISTORY_EVENTS: usize = 100_000;
const MAX_HISTORY_LINE_BYTES: usize = 262_144;

#[derive(Clone, Debug)]
pub(crate) struct DashboardLedgerEvent {
    pub id: String,
    pub record_id: String,
    pub kind: String,
    pub action: String,
    pub at: String,
}

#[derive(Clone, Debug)]
pub(crate) struct DashboardLedgerHistory {
    pub revision: String,
    pub events: Vec<DashboardLedgerEvent>,
}

pub(super) fn read(root: &Path) -> Result<DashboardLedgerHistory, ProjectLedgerReadError> {
    let path = root.join("ledger.jsonl");
    let path_metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DashboardLedgerHistory {
                revision: "absent".into(),
                events: Vec::new(),
            });
        }
        Err(_) => return Err(unavailable()),
    };
    if !path_metadata.is_file()
        || path_metadata.file_type().is_symlink()
        || path_metadata.len() > MAX_HISTORY_BYTES
    {
        return Err(unavailable());
    }
    let revision = file_revision(&path_metadata);
    let mut file = File::open(&path).map_err(|_| unavailable())?;
    let opened_metadata = file.metadata().map_err(|_| unavailable())?;
    if !opened_metadata.is_file() || file_revision(&opened_metadata) != revision {
        return Err(changed());
    }
    let mut limited = file.take(MAX_HISTORY_BYTES + 1);
    let mut bytes = Vec::with_capacity(path_metadata.len() as usize);
    limited.read_to_end(&mut bytes).map_err(|_| unavailable())?;
    file = limited.into_inner();
    if bytes.len() as u64 > MAX_HISTORY_BYTES {
        return Err(unavailable());
    }
    let descriptor_metadata = file.metadata().map_err(|_| unavailable())?;
    let final_path_metadata = fs::symlink_metadata(&path).map_err(|_| changed())?;
    if !final_path_metadata.is_file()
        || final_path_metadata.file_type().is_symlink()
        || file_revision(&descriptor_metadata) != revision
        || file_revision(&final_path_metadata) != revision
        || bytes.len() as u64 != path_metadata.len()
    {
        return Err(changed());
    }

    let mut events = Vec::new();
    let mut invalid_lines = 0;
    let mut offset = bytes.len();
    for delimited_line in bytes.split_inclusive(|byte| *byte == b'\n').rev() {
        offset -= delimited_line.len();
        let line = delimited_line.strip_suffix(b"\n").unwrap_or(delimited_line);
        if line.len() > MAX_HISTORY_LINE_BYTES {
            return Err(ProjectLedgerReadError::DashboardInternal(
                "dashboard_history_record_too_large",
            ));
        }
        let raw = String::from_utf8_lossy(line);
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => {
                if let Some(event) = event(&value, path_identity(&path_metadata), offset) {
                    events.push(event);
                    if events.len() > MAX_HISTORY_EVENTS {
                        return Err(unavailable());
                    }
                }
            }
            Err(_) if !raw.trim().is_empty() => invalid_lines += 1,
            Err(_) => {}
        }
    }
    if invalid_lines > 0 {
        return Err(ProjectLedgerReadError::DashboardInternal(
            "dashboard_history_incomplete",
        ));
    }
    Ok(DashboardLedgerHistory { revision, events })
}

fn event(value: &Value, inode: u64, offset: usize) -> Option<DashboardLedgerEvent> {
    let event_type = value.get("type")?.as_str()?;
    let (kind, action) = match event_type {
        "work_created" => ("work", "created"),
        "work_updated" => ("work", "updated"),
        "work_completed" => ("work", "completed"),
        "task_created" => ("task", "created"),
        "task_updated" => ("task", "updated"),
        "task_completed" => ("task", "completed"),
        "plan_created" => ("plan", "created"),
        "plan_updated" => ("plan", "updated"),
        "plan_completed" => ("plan", "completed"),
        "spec_created" => ("spec", "created"),
        "spec_updated" => ("spec", "updated"),
        "spec_completed" => ("spec", "completed"),
        "report_created" => ("report", "created"),
        "report_updated" => ("report", "updated"),
        "report_completed" => ("report", "completed"),
        _ => return None,
    };
    let record_id = value.get("id")?.as_str()?.to_owned();
    let at = value.get("ts")?.as_str()?.to_owned();
    crate::js_date::parse_iso_millis(&at)?;
    Some(DashboardLedgerEvent {
        id: format!("{inode}:{offset}"),
        record_id,
        kind: kind.into(),
        action: action.into(),
        at,
    })
}

fn path_identity(metadata: &Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

fn file_revision(metadata: &Metadata) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(epoch_millis)
        .map(number_string)
        .unwrap_or_else(|| "null".into());
    let changed = change_time_millis(metadata)
        .map(number_string)
        .unwrap_or_else(|| "null".into());
    format!(
        "{}:{}:{modified}:{changed}",
        path_identity(metadata),
        metadata.len()
    )
}

#[cfg(unix)]
fn change_time_millis(metadata: &Metadata) -> Option<f64> {
    use std::os::unix::fs::MetadataExt;
    Some(metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1_000_000.0)
}

#[cfg(not(unix))]
fn change_time_millis(metadata: &Metadata) -> Option<f64> {
    metadata.created().ok().and_then(epoch_millis)
}

fn epoch_millis(value: std::time::SystemTime) -> Option<f64> {
    let duration = value.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1_000_000.0)
}

fn number_string(value: f64) -> String {
    format!("{value}")
}

fn unavailable() -> ProjectLedgerReadError {
    ProjectLedgerReadError::DashboardInternal("dashboard_history_unavailable")
}

fn changed() -> ProjectLedgerReadError {
    ProjectLedgerReadError::DashboardInternal("dashboard_history_changed")
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::read;

    struct TemporaryRoot(PathBuf);

    impl TemporaryRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("butler-ledger-history-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TemporaryRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn history_reads_metadata_only_events_newest_first_and_absent_log_is_empty() {
        {
            let temp = TemporaryRoot::new();
            fs::write(
                temp.path().join("ledger.jsonl"),
                concat!(
                    "{\"type\":\"work_created\",\"id\":\"w1\",\"ts\":\"2026-09-24T12:00:00.000Z\",\"private\":\"not returned\"}\n",
                    "{\"type\":\"plan_updated\",\"id\":\"p1\",\"ts\":\"2026-09-24T12:01:00.000Z\"}\n"
                ),
            )
            .unwrap();

            let history = read(temp.path()).unwrap();
            assert_eq!(history.events.len(), 2);
            assert_eq!(history.events[0].record_id, "p1");
            assert_eq!(history.events[0].kind, "plan");
            assert_eq!(history.events[0].action, "updated");
            assert_eq!(history.events[1].record_id, "w1");
            assert!(history.events[1].id.ends_with(":0"));
        }
        {
            let temp = TemporaryRoot::new();
            let history = read(temp.path()).unwrap();
            assert_eq!(history.revision, "absent");
            assert!(history.events.is_empty());
        }
    }
}
