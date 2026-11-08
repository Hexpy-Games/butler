//! `ui-crash-log.mjs` + `ui-crash-store.mjs`: a panic becomes a record that carries no prose,
//! payload or private path, kept in `app/logs/ui-crashes.json` (50 entries, under 256 KB).
use std::backtrace::Backtrace;
use std::io::Write as _;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};

use butler_platform::data_paths::APP_LOGS;
use butler_platform::secure_fs;
use chrono::{SecondsFormat, Utc};
use regex::Regex;
use serde_json::{Value, json};

/// `CRASH_LOG_LIMIT`
const LIMIT: usize = 50;
/// `CRASH_LOG_BYTES`
const BYTES: usize = 256 * 1024;
/// `.slice(0, 30)` of frames.
const FRAMES: usize = 30;

static STORE_LOCK: Mutex<()> = Mutex::new(());

fn store_path(data: &Path) -> PathBuf {
    data.join(APP_LOGS).join("ui-crashes.json")
}

/// `read`: a missing, damaged or oversized file is an empty log.
pub(super) fn read(data: &Path) -> Vec<Value> {
    let path = store_path(data);
    let fits = std::fs::metadata(&path)
        .is_ok_and(|meta| usize::try_from(meta.len()).is_ok_and(|len| len < BYTES));
    if !fits {
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(mut entries)) => entries.split_off(entries.len().saturating_sub(LIMIT)),
        _ => Vec::new(),
    }
}

/// `appendCrash` + the store's atomic, owner-only replace. One writer at a time.
pub(super) fn append(data: &Path, record: Value) -> std::io::Result<()> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut entries = read(data);
    let excess = entries.len().saturating_sub(LIMIT - 1);
    entries.drain(..excess);
    entries.push(record);
    while entries.len() > 1 && serde_json::to_vec(&entries).map_or(0, |bytes| bytes.len()) >= BYTES
    {
        entries.remove(0);
    }
    let path = store_path(data);
    if let Some(parent) = path.parent() {
        secure_fs::create_private_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(&entries)?;
    secure_fs::replace_private(&path, |file| file.write_all(&bytes), |error| error)
}

/// `normalizeCrash` for a Rust panic: the message is never kept, only the kind; the stack is
/// function, file name, line and column.
pub(super) fn from_panic(info: &PanicHookInfo<'_>) -> Value {
    let mut frames = Vec::new();
    if let Some(at) = info.location() {
        frames.push(frame("panic", at.file(), at.line(), at.column()));
    }
    frames.extend(backtrace_frames(&Backtrace::force_capture().to_string()));
    frames.truncate(FRAMES);
    json!({
        "message": "Panic: [redacted]",
        "stack": frames.join("\n"),
        "componentStack": "",
        "page": "app",
        "scope": "app",
        "appVersion": app_version(),
        "timestamp": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

fn app_version() -> &'static str {
    static CELL: OnceLock<Option<Regex>> = OnceLock::new();
    let version = env!("CARGO_PKG_VERSION");
    let cell = CELL.get_or_init(|| Regex::new(r"(?i)^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$").ok());
    if cell.as_ref().is_some_and(|re| re.is_match(version)) {
        version
    } else {
        "unknown"
    }
}

/// `    at <fn> (<file>:<line>:<col>)`, the file by name only.
fn frame(name: &str, file: &str, line: u32, column: u32) -> String {
    let file = file.rsplit(['/', '\\']).next().unwrap_or("<script>");
    format!("    at {name} ({file}:{line}:{column})")
}

/// The frames of the std backtrace text that have a source file in this build.
fn backtrace_frames(text: &str) -> Vec<String> {
    static CELL: OnceLock<Option<(Regex, Regex)>> = OnceLock::new();
    let patterns = CELL.get_or_init(|| {
        Some((
            Regex::new(r"^\s*\d+:\s+(.+)$").ok()?,
            Regex::new(r"^\s*at\s+(.+?):(\d+):(\d+)$").ok()?,
        ))
    });
    let Some((head, location)) = patterns else {
        return Vec::new();
    };
    let mut name: Option<String> = None;
    let mut frames = Vec::new();
    for line in text.lines() {
        if let Some(found) = head.captures(line) {
            name = Some(function_name(&found[1]));
        } else if let (Some(found), Some(name)) = (location.captures(line), name.as_deref()) {
            let file = &found[1];
            if file.contains("/rustc/") || file.contains("\\rustc\\") {
                continue;
            }
            let (line, column) = (found[2].parse().unwrap_or(0), found[3].parse().unwrap_or(0));
            frames.push(frame(name, file, line, column));
        }
    }
    frames
}

/// The last readable path segment of a symbol, without the `::h<hash>` suffix.
fn function_name(symbol: &str) -> String {
    symbol
        .rsplit("::")
        .find(|part| {
            let hash = part.len() == 17
                && part.starts_with('h')
                && part[1..].bytes().all(|b| b.is_ascii_hexdigit());
            !hash && part.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        })
        .map(|part| {
            part.chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .take(80)
                .collect()
        })
        .unwrap_or_else(|| "<frame>".to_owned())
}
