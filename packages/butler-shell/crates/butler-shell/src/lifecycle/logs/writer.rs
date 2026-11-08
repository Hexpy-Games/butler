//! `log/writer.mjs`: the App alone owns `logs/app`. Rows are redacted, filtered by the level
//! the agent's `/logs/config` says, and appended to rotating segments with retention.
//! Runs on the one thread `mod.rs` starts, so no lock guards any of it.
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use butler_platform::data_paths::{LOCAL_ADMIN, LOCAL_AUTH};
use butler_platform::secure_fs;
use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

use super::redact::Redactor;

const MB: usize = 1024 * 1024;
const ROTATE: usize = 16 * MB;

fn severity(level: &str) -> usize {
    ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"]
        .iter()
        .position(|known| *known == level)
        .map_or(0, |at| at + 1)
}

fn threshold(level: &str) -> Option<usize> {
    ["minimal", "standard", "detailed", "full"]
        .iter()
        .position(|known| *known == level)
        .map(|at| at + 2)
}

/// `effective` of `/logs/config`.
#[derive(Clone)]
struct Config {
    level: String,
    category_levels: Vec<(String, String)>,
}

impl Config {
    fn standard() -> Self {
        Self {
            level: "standard".to_owned(),
            category_levels: Vec::new(),
        }
    }

    fn parse(effective: &Value) -> Option<Self> {
        let level = effective.get("level")?.as_str()?;
        threshold(level)?;
        let mut category_levels: Vec<(String, String)> = effective
            .get("category_levels")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
                    .collect()
            })
            .unwrap_or_default();
        category_levels.sort_by_key(|(key, _)| key.len());
        Some(Self {
            level: level.to_owned(),
            category_levels,
        })
    }
}

struct Segment {
    file: File,
    path: PathBuf,
    bytes: usize,
}

pub(super) struct Writer {
    root: PathBuf,
    redactor: Redactor,
    config: Config,
    fallback: Config,
    full_expires_ms: Option<i64>,
    queue: Vec<Value>,
    queued_bytes: usize,
    lanes: HashMap<&'static str, Segment>,
    sequence: u32,
    secrets_loaded: [bool; 2],
    pub(super) stopped: bool,
}

impl Writer {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            redactor: Redactor::default(),
            config: Config::standard(),
            fallback: Config::standard(),
            full_expires_ms: None,
            queue: Vec::new(),
            queued_bytes: 0,
            lanes: HashMap::new(),
            sequence: 0,
            secrets_loaded: [false; 2],
            stopped: false,
        }
    }

    /// `loadSecrets`: the agent's two credentials, read once they exist.
    /// `Err` is a file that exists but cannot be read; nothing is written then.
    fn load_secrets(&mut self) -> std::io::Result<()> {
        for (slot, (file, field)) in [(LOCAL_AUTH, "token"), (LOCAL_ADMIN, "secret")]
            .into_iter()
            .enumerate()
        {
            if self.secrets_loaded[slot] {
                continue;
            }
            match fs::read_to_string(self.root.join(file)) {
                Ok(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    if let Some(secret) = value.get(field).and_then(Value::as_str) {
                        self.redactor.remember(secret, true);
                    }
                    self.secrets_loaded[slot] = true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    /// `enabled`: a `full` level that has run out falls back first.
    fn enabled(&mut self, category: &str, level: &str) -> bool {
        if self.config.level == "full"
            && self
                .full_expires_ms
                .is_some_and(|at| Utc::now().timestamp_millis() >= at)
        {
            let fallback = self.fallback.clone();
            self.apply(fallback, None, None);
        }
        let mut limit = threshold(&self.config.level).unwrap_or(3);
        for (key, value) in &self.config.category_levels {
            if category == key.as_str()
                || category
                    .strip_prefix(key.as_str())
                    .is_some_and(|rest| rest.starts_with('.'))
            {
                limit = severity(value);
            }
        }
        if level == "TRACE" && self.config.level != "full" {
            return false;
        }
        (1..=limit).contains(&severity(level))
    }

    /// `record`: redact, bound and queue one row. Returns whether it must be written now.
    pub(super) fn record(&mut self, row: &Value) -> bool {
        let level = row.get("level").and_then(Value::as_str).unwrap_or("");
        let category = row.get("category").and_then(Value::as_str).unwrap_or("");
        if self.stopped || !self.enabled(category, level) {
            return false;
        }
        let row = self.redactor.redact(row);
        let size = row.to_string().len();
        if size > MB || (severity(level) >= 4 && self.queued_bytes + size > ROTATE) {
            return false;
        }
        self.queue.push(row);
        self.queued_bytes += size;
        level == "ERROR" || self.queued_bytes >= MB
    }

    fn lane_dir(&self, lane: &str) -> PathBuf {
        self.root.join("logs").join("app").join(lane)
    }

    fn segment(&mut self, lane: &'static str) -> std::io::Result<&mut Segment> {
        if !self.lanes.contains_key(lane) {
            let dir = self.lane_dir(lane);
            secure_fs::create_private_dir_all(&dir)?;
            let prefix = Utc::now().format("%Y%m%dT%H%M%SZ");
            self.sequence += 1;
            let path = dir.join(format!(
                "{prefix}-{:04}-{}.jsonl",
                self.sequence,
                Uuid::new_v4()
            ));
            let mut options = OpenOptions::new();
            options.create_new(true).append(true);
            secure_fs::owner_only(&mut options);
            let file = options.open(&path)?;
            self.lanes.insert(
                lane,
                Segment {
                    file,
                    path,
                    bytes: 0,
                },
            );
        }
        self.lanes
            .get_mut(lane)
            .ok_or_else(|| std::io::Error::other("log segment"))
    }

    fn close(&mut self, lane: &str) {
        if let Some(entry) = self.lanes.remove(lane) {
            let _ = entry.file.sync_all();
        }
    }

    /// `prune`: size cap and age per lane; the open segment is kept.
    fn prune(&self, lane: &str) {
        let ext = if lane == "bodies" { "zst" } else { "jsonl" };
        let Ok(names) = fs::read_dir(self.lane_dir(lane)) else {
            return;
        };
        let mut files: Vec<(PathBuf, u64, SystemTime)> = names
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|found| found == ext))
            .filter_map(|path| {
                let meta = fs::metadata(&path).ok()?;
                Some((path, meta.len(), meta.modified().ok()?))
            })
            .collect();
        files.sort();
        let mut total: u64 = files.iter().map(|file| file.1).sum();
        let (cap, hours) = match lane {
            "main" => (64, 14 * 24),
            "bodies" => (256, 24),
            _ => (256, 72),
        };
        let cap = cap * (MB as u64);
        let age = Duration::from_secs(hours * 3600);
        let active = self.lanes.get(lane).map(|entry| &entry.path);
        for (path, size, modified) in files {
            let old = modified.elapsed().is_ok_and(|elapsed| elapsed > age);
            if Some(&path) == active || (total <= cap && !old) {
                continue;
            }
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("idx"));
            total = total.saturating_sub(size);
        }
    }

    /// `flush`: the queue, split into the `main` (INFO and above) and `debug` lanes.
    pub(super) fn flush(&mut self) {
        let batch = std::mem::take(&mut self.queue);
        self.queued_bytes = 0;
        if batch.is_empty() || self.load_secrets().is_err() {
            return;
        }
        for lane in ["main", "debug"] {
            let rows: Vec<&Value> = batch
                .iter()
                .filter(|row| {
                    let level = row.get("level").and_then(Value::as_str).unwrap_or("");
                    (if severity(level) <= 3 {
                        "main"
                    } else {
                        "debug"
                    }) == lane
                })
                .collect();
            if !rows.is_empty() {
                let _ = self.write_lane(lane, &rows);
            }
        }
    }

    fn write_lane(&mut self, lane: &'static str, rows: &[&Value]) -> std::io::Result<()> {
        if self
            .lanes
            .get(lane)
            .is_some_and(|entry| !entry.path.exists())
        {
            self.close(lane);
        }
        let mut lines = String::new();
        let mut sync = false;
        for row in rows {
            let line = format!("{row}\n");
            if line.len() > MB {
                continue;
            }
            let entry = self.segment(lane)?;
            if entry.bytes + line.len() > ROTATE {
                entry.file.write_all(lines.as_bytes())?;
                lines.clear();
                self.close(lane);
            }
            let entry = self.segment(lane)?;
            entry.bytes += line.len();
            sync |= row.get("level").and_then(Value::as_str) == Some("ERROR");
            lines.push_str(&line);
        }
        if !lines.is_empty() {
            let entry = self.segment(lane)?;
            entry.file.write_all(lines.as_bytes())?;
            if sync {
                entry.file.sync_all()?;
            }
            self.prune(lane);
        }
        Ok(())
    }

    /// `configure`: the agent's effective level, with the cleanup a lower level implies.
    pub(super) fn configure(&mut self, view: &Value) {
        let Some(effective) = view.get("effective").and_then(Config::parse) else {
            return;
        };
        let expires = view
            .get("full_expires_at")
            .and_then(Value::as_str)
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|time| time.timestamp_millis());
        let generation = view
            .get("clear_generation")
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.flush();
        self.apply(effective, expires, generation);
    }

    fn apply(&mut self, effective: Config, expires: Option<i64>, generation: Option<String>) {
        if effective.level == "full" {
            if self.config.level != "full" {
                self.fallback = self.config.clone();
            }
            self.full_expires_ms = expires
                .or(self.full_expires_ms)
                .or_else(|| Some(Utc::now().timestamp_millis() + 3_600_000));
        } else {
            self.fallback = effective.clone();
            self.full_expires_ms = None;
        }
        let verbose = matches!(effective.level.as_str(), "detailed" | "full");
        let full = effective.level == "full";
        self.config = effective;
        let generation =
            generation.or_else(|| fs::read_to_string(self.root.join("logs/clear-generation")).ok());
        self.reconcile_clear(generation.as_deref());
        for lane in [("debug", !verbose), ("bodies", !full)]
            .into_iter()
            .filter(|lane| lane.1)
            .map(|lane| lane.0)
        {
            self.close(lane);
            let _ = fs::remove_dir_all(self.lane_dir(lane));
        }
        for lane in ["main", "debug", "bodies"] {
            self.prune(lane);
        }
    }

    /// `reconcileClear`: the agent's clear marker, applied once.
    fn reconcile_clear(&mut self, generation: Option<&str>) {
        let Some(generation) = generation else {
            return;
        };
        let marker = self.root.join("logs/app-clear-generation");
        if fs::read_to_string(&marker).ok().as_deref() == Some(generation) {
            return;
        }
        self.clear();
        let _ = secure_fs::create_private_dir_all(&self.root.join("logs"));
        let _ = secure_fs::replace_private(
            &marker,
            |file| file.write_all(generation.as_bytes()),
            |error| error,
        );
    }

    /// `clear`: the queue and every stored segment.
    pub(super) fn clear(&mut self) {
        self.queue.clear();
        self.queued_bytes = 0;
        for lane in ["main", "debug", "bodies"] {
            self.close(lane);
        }
        let _ = fs::remove_dir_all(self.root.join("logs").join("app"));
    }

    /// `quit`: drain and close, then take no more rows.
    pub(super) fn quit(&mut self) {
        self.flush();
        self.stopped = true;
        for lane in ["main", "debug", "bodies"] {
            self.close(lane);
        }
    }
}
