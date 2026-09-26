use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

use serde_json::{Map, Value};

use super::{
    AutomationError,
    records::{
        AutomationPreview, AutomationRecord, AutomationSchedule, ClaimedAutomationRun, envelope,
        format_millis, preview,
    },
};
mod claim;
use claim::claim_record;
mod persistence;
use persistence::{
    ensure_record_id, ensure_store_directory, path_entry_exists, read_record, write_record,
};

const STORE_LOCK_FILE: &str = ".automation-store.lock";

pub(super) struct AutomationStore {
    root: PathBuf,
}

impl AutomationStore {
    pub(super) fn new(data_root: &Path) -> Self {
        Self {
            root: data_root.join("automations"),
        }
    }

    pub(super) fn create(
        &self,
        args: &Map<String, Value>,
        default_session: &str,
        now_ms: i64,
        parse: &dyn Fn(&str) -> Option<i64>,
    ) -> Result<AutomationPreview, AutomationError> {
        let _lock = self.write_lock()?;
        let prompt = string(args, "prompt").unwrap_or_default().trim().to_owned();
        let session_id = string(args, "session_id")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_session)
            .trim()
            .to_owned();
        if prompt.is_empty() {
            return Err(invalid("automation prompt must be non-empty"));
        }
        if session_id.is_empty() {
            return Err(invalid("automation session_id must be non-empty"));
        }
        let schedule = schedule(args, parse)?;
        let now = format_millis(now_ms)?;
        let generated = format!(
            "automation-{now_ms}-{}",
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        let id = safe_id(
            string(args, "id")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or(&generated),
        )?;
        let path = self.path_for(&id)?;
        if path_entry_exists(&path)? {
            return Err(invalid(format!("automation {id} already exists")));
        }
        let title = string(args, "title")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| super::records::utf16_prefix(&prompt, 80));
        let next_run_at = match &schedule {
            AutomationSchedule::Once { run_at } => run_at.clone(),
            AutomationSchedule::Interval { start_at, .. } => {
                start_at.clone().unwrap_or_else(|| now.clone())
            }
        };
        let record = AutomationRecord {
            version: 1,
            id,
            title,
            prompt,
            session_id,
            status: "active".into(),
            schedule,
            next_run_at: Some(next_run_at),
            last_run_at: None,
            run_count: 0,
            created_at: now.clone(),
            updated_at: now,
        };
        write_record(&path, &record)?;
        Ok(preview(&record))
    }

    pub(super) fn list(
        &self,
        include_deleted: bool,
    ) -> Result<Vec<AutomationPreview>, AutomationError> {
        let entries = match fs::symlink_metadata(&self.root) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(invalid(
                    "automation store path must be a real DATA directory",
                ));
            }
            Ok(_) => fs::read_dir(&self.root).map_err(io_error)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_error(error)),
        };
        let mut records = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            if metadata.file_type().is_symlink() {
                return Err(invalid("automation record paths cannot be symlinks"));
            }
            if !metadata.is_file() {
                continue;
            }
            if let Some(record) = read_record(&path) {
                if safe_id(&record.id).is_err()
                    || path.file_stem().and_then(|stem| stem.to_str()) != Some(record.id.as_str())
                {
                    return Err(invalid("automation record id does not match its DATA path"));
                }
                if include_deleted || record.status != "deleted" {
                    records.push(record);
                }
            }
        }
        records.sort_by(|a, b| {
            a.next_run_at
                .as_deref()
                .unwrap_or("")
                .cmp(b.next_run_at.as_deref().unwrap_or(""))
        });
        Ok(records.iter().map(preview).collect())
    }

    pub(super) fn delete(
        &self,
        id: &str,
        now_ms: i64,
    ) -> Result<AutomationPreview, AutomationError> {
        let _lock = self.write_lock()?;
        let path = self.path_for(id)?;
        let mut record =
            read_record(&path).ok_or_else(|| invalid(format!("automation {id} not found")))?;
        ensure_record_id(&record, id)?;
        record.status = "deleted".into();
        record.next_run_at = None;
        record.updated_at = format_millis(now_ms)?;
        write_record(&path, &record)?;
        Ok(preview(&record))
    }

    pub(super) fn read(&self, id: &str) -> Result<Option<AutomationPreview>, AutomationError> {
        let path = self.path_for(id)?;
        if !path_entry_exists(&path)? {
            return Ok(None);
        }
        let Some(record) = read_record(&path) else {
            return Ok(None);
        };
        ensure_record_id(&record, id)?;
        Ok(Some(preview(&record)))
    }

    pub(super) fn run_now(
        &self,
        id: &str,
        now_ms: i64,
        parse: &dyn Fn(&str) -> Option<i64>,
    ) -> Result<ClaimedAutomationRun, AutomationError> {
        let _lock = self.write_lock()?;
        let now = format_millis(now_ms)?;
        let path = self.path_for(id)?;
        let mut record =
            read_record(&path).ok_or_else(|| invalid(format!("automation {id} not found")))?;
        ensure_record_id(&record, id)?;
        if record.status != "active" {
            return Err(invalid(format!(
                "automation {id} is {}; only active automations can be run",
                record.status
            )));
        }
        let run = claim_record(&mut record, now_ms, &now, parse)?;
        write_record(&path, &record)?;
        Ok(run)
    }

    pub(super) fn claim_due(
        &self,
        now_ms: i64,
        parse: &dyn Fn(&str) -> Option<i64>,
    ) -> Result<Vec<ClaimedAutomationRun>, AutomationError> {
        let _lock = self.write_lock()?;
        let now = format_millis(now_ms)?;
        let previews = self.list(false)?;
        let mut due = Vec::new();
        for item in previews {
            let path = self.path_for(&item.id)?;
            let Some(mut record) = read_record(&path) else {
                continue;
            };
            if record.status != "active" {
                continue;
            }
            let Some(next) = record.next_run_at.as_deref() else {
                continue;
            };
            let next_ms = parse(next)
                .ok_or_else(|| invalid("automation next_run_at must be a valid ISO date"))?;
            if next_ms > now_ms {
                continue;
            }
            due.push(claim_record(&mut record, now_ms, &now, parse)?);
            write_record(&path, &record)?;
        }
        Ok(due)
    }

    fn write_lock(&self) -> Result<File, AutomationError> {
        ensure_store_directory(&self.root)?;
        let path = self.root.join(STORE_LOCK_FILE);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        options
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC);
        let file = options.open(path).map_err(io_error)?;
        if !file.metadata().map_err(io_error)?.is_file() {
            return Err(invalid("automation store lock must be a regular file"));
        }
        file.lock().map_err(io_error)?;
        Ok(file)
    }

    fn path_for(&self, id: &str) -> Result<PathBuf, AutomationError> {
        Ok(self.root.join(format!("{}.json", safe_id(id)?)))
    }
}

fn schedule(
    args: &Map<String, Value>,
    parse: &dyn Fn(&str) -> Option<i64>,
) -> Result<AutomationSchedule, AutomationError> {
    match string(args, "schedule_type").map(str::trim) {
        Some("once") => {
            let value = string(args, "run_at")
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| invalid("create_automation once schedule requires run_at"))?;
            let millis = parse(value)
                .ok_or_else(|| invalid("automation run_at must be a valid ISO date"))?;
            Ok(AutomationSchedule::Once {
                run_at: format_millis(millis)?,
            })
        }
        Some("interval") => {
            let number = args
                .get("interval_minutes")
                .and_then(Value::as_f64)
                .ok_or_else(|| {
                    invalid("create_automation interval schedule requires interval_minutes")
                })?;
            let interval_minutes = crate::json::saturating_i64(number.trunc());
            if !number.is_finite() || interval_minutes < 1 {
                return Err(invalid("automation interval_minutes must be at least 1"));
            }
            let start_at = string(args, "start_at")
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(|value| {
                    parse(value)
                        .and_then(crate::js_date::format_iso_millis)
                        .ok_or_else(|| invalid("automation start_at must be a valid ISO date"))
                })
                .transpose()?;
            Ok(AutomationSchedule::Interval {
                interval_minutes,
                start_at,
            })
        }
        _ => Err(invalid(
            "create_automation requires schedule_type once or interval",
        )),
    }
}

fn string<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn safe_id(value: &str) -> Result<String, AutomationError> {
    let value = value.trim();
    let valid = (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte));
    valid
        .then(|| value.to_owned())
        .ok_or_else(|| invalid("automation id must be 1-100 safe characters"))
}

fn invalid(message: impl Into<String>) -> AutomationError {
    AutomationError::new("automation_invalid", message)
}
fn io_error(error: impl std::fmt::Display) -> AutomationError {
    AutomationError::new("automation_store_unavailable", error.to_string())
}
