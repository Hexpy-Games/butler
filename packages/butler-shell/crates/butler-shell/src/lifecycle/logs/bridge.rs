//! The `log` records of gpui, wgpu and the shell's crates, as app log rows: third-party crates at
//! WARN and above, Butler's at INFO and above. Each call site writes at most [`PER_SITE`] rows per
//! [`WINDOW`]; the rest are counted and reported as one `log.suppressed` row when that site logs
//! again after its window. No timer: an idle App writes nothing.

use std::collections::HashMap;
use std::io::IsTerminal as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use log::{Level, LevelFilter, Log, Metadata, Record};
use serde_json::json;

const PER_SITE: u32 = 5;
const WINDOW: Duration = Duration::from_secs(60);
/// Longest message kept; the rest is cut (a record is a diagnostic, not a payload).
const MESSAGE_MAX: usize = 2000;

struct Site {
    start: Instant,
    count: u32,
    suppressed: u32,
}

#[derive(Default)]
struct Bridge {
    sites: Mutex<HashMap<String, Site>>,
}

/// Installs the bridge once; a second call (or another logger) is ignored.
pub(crate) fn install() {
    if log::set_boxed_logger(Box::new(Bridge::default())).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

fn butler(target: &str) -> bool {
    target.starts_with("butler")
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug => "DEBUG",
        Level::Trace => "TRACE",
    }
}

impl Bridge {
    /// `Some(suppressed)` when this record is written (with the count dropped in the site's
    /// previous window), `None` when it is dropped.
    fn admit(&self, site: String, now: Instant) -> Option<u32> {
        let mut sites = self.sites.lock().ok()?;
        let entry = sites.entry(site).or_insert(Site {
            start: now,
            count: 0,
            suppressed: 0,
        });
        if now.duration_since(entry.start) >= WINDOW {
            let suppressed = entry.suppressed;
            *entry = Site {
                start: now,
                count: 1,
                suppressed: 0,
            };
            return Some(suppressed);
        }
        if entry.count < PER_SITE {
            entry.count += 1;
            Some(0)
        } else {
            entry.suppressed += 1;
            None
        }
    }
}

impl Log for Bridge {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= Level::Warn
            || (metadata.level() <= Level::Info && butler(metadata.target()))
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let target = record.target();
        let site = format!(
            "{target}@{}:{}",
            record.file().unwrap_or(""),
            record.line().unwrap_or(0)
        );
        let Some(suppressed) = self.admit(site.clone(), Instant::now()) else {
            return;
        };
        let crate_name = target.split("::").next().unwrap_or(target);
        let category = format!("app.native.{crate_name}");
        let level = level_name(record.level());
        if suppressed > 0 {
            super::app_log(
                "WARN",
                &category,
                "log.suppressed",
                json!({ "site": site, "count": suppressed }),
            );
        }
        let mut message = record.args().to_string();
        if message.len() > MESSAGE_MAX {
            let cut = (0..=MESSAGE_MAX)
                .rev()
                .find(|&at| message.is_char_boundary(at))
                .unwrap_or(0);
            message.truncate(cut);
        }
        if std::io::stderr().is_terminal() {
            eprintln!("{level} {target}: {message}");
        }
        super::app_log(
            level,
            &category,
            "log",
            json!({ "site": site, "message": message }),
        );
    }

    fn flush(&self) {}
}
