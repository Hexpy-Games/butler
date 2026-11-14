//! The App's own records (`ui-crash-log.mjs`, `ui-crash-store.mjs`, `log/*.mjs`): a panic
//! becomes a redacted crash record, and app events go to the `logs/app` store.
//!
//! One owned thread writes the store (`writer.rs`); callers only send it rows. The IPC payload
//! `bodies` lane of `log/bodies.mjs` is not ported: it records Electron IPC at the `full`
//! level, and the shell has no IPC.
mod crash;
mod redact;
mod writer;
pub(crate) mod zip;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use chrono::Utc;
use gpui::App;
use serde_json::{Value, json};

use writer::Writer;

use crate::ui::source::agent::Jobs;

/// What the writer thread is asked to do.
enum Msg {
    Record(Value),
    Configure(Value),
    Clear,
    Flush(Sender<()>),
    Quit(Sender<()>),
}

static WRITER: OnceLock<Sender<Msg>> = OnceLock::new();
static DATA: OnceLock<PathBuf> = OnceLock::new();

/// `MESSAGES` + `appMessage`: the readable text of an event id.
fn message(event: &str) -> String {
    let known = match event {
        "app.start" => "App started",
        "app.quit" => "App quit",
        "app.start_failed" => "App startup failed",
        "app.version_failed" => "App version unavailable",
        "renderer.crash" => "Renderer crashed",
        "process.crash" => "Process crashed",
        "agent.spawn" => "Agent started",
        "agent.exit" => "Agent exited",
        "agent.spawn_failed" => "Agent startup failed",
        "agent.restart" => "Agent restart requested",
        "ui.send" => "Message sent",
        "ui.stop" => "Response stopped",
        "ui.model_pick" => "Model selected",
        "ui.retry" => "Message retried",
        "ui.error" => "UI error",
        "image.fetch" => "Image requested",
        "browser.request" => "Browser request started",
        "browser.completed" => "Browser request completed",
        "update.check" => "Checking for updates",
        "update.failed" => "Update failed",
        "update.update-available" => "Update available",
        "update.update-not-available" => "App is up to date",
        "update.update-downloaded" => "Update downloaded",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_owned();
    }
    let spaced = event.replace(['.', '_', '-'], " ");
    let mut chars = spaced.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// The thread body: rows are batched for 100 ms, an ERROR or an explicit flush writes at once.
fn run(root: PathBuf, rx: &Receiver<Msg>) {
    let mut writer = Writer::new(root);
    while let Ok(first) = rx.recv() {
        let deadline = Instant::now() + Duration::from_millis(100);
        let mut next = Some(first);
        let mut now = false;
        while let Some(msg) = next.take() {
            match msg {
                Msg::Record(row) => now |= writer.record(&row),
                Msg::Configure(view) => writer.configure(&view),
                Msg::Clear => writer.clear(),
                Msg::Flush(done) => {
                    writer.flush();
                    let _ = done.send(());
                }
                Msg::Quit(done) => {
                    writer.quit();
                    let _ = done.send(());
                    return;
                }
            }
            if !now {
                next = rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .ok();
            }
        }
        writer.flush();
    }
}

fn send(msg: Msg) {
    if let Some(tx) = WRITER.get() {
        let _ = tx.send(msg);
    }
}

fn row(level: &str, category: &str, event: &str, attrs: Value) -> Value {
    let mut row = json!({
        "ts": Utc::now().format("%Y-%m-%dT%H:%M:%S%.3f000Z").to_string(),
        "attrs": {},
        "level": level,
        "category": category,
        "event": event,
        "msg": message(event),
        "process": "app.main",
    });
    row["attrs"] = attrs;
    row
}

/// Waits (at most a second) for the writer to have written everything sent so far.
fn flush_now() {
    let (done, wait) = channel();
    send(Msg::Flush(done));
    let _ = wait.recv_timeout(Duration::from_secs(1));
}

/// Starts the app log for `data` and records every later panic in
/// `<data>/app/logs/ui-crashes.json` (and as a `ui.error` row).
pub(crate) fn install_crash_hook(data: &Path) {
    if WRITER.get().is_none() {
        let (tx, rx) = channel();
        let root = data.to_path_buf();
        if std::thread::Builder::new()
            .name("butler-app-log".to_owned())
            .spawn(move || run(root, &rx))
            .is_ok()
        {
            let _ = WRITER.set(tx);
            let _ = DATA.set(data.to_path_buf());
            app_log(
                "INFO",
                "lifecycle",
                "app.start",
                json!({ "version": crate::lifecycle::APP_VERSION }),
            );
        }
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let record = crash::from_panic(info);
        if let Some(data) = DATA.get() {
            let _ = crash::append(data, record.clone());
        }
        let mut error = row("ERROR", "app.ui", "ui.error", json!({}));
        error["msg"] = json!("UI error · app");
        error["error"] = record;
        send(Msg::Record(error));
        flush_now();
        previous(info);
    }));
}

/// The crash records, newest last.
pub(crate) fn read_crashes(data: &Path) -> Vec<Value> {
    crash::read(data)
}

/// One app log line (`ui.send`, `ui.error`, …); secrets are redacted before writing.
pub(crate) fn app_log(level: &str, category: &str, event: &str, attrs: Value) {
    send(Msg::Record(row(level, category, event, attrs)));
}

/// `refresh`: reads `/logs/config` and the committed settings, then applies them. A failed
/// read keeps the last level while reconnecting.
pub(crate) fn refresh(cx: &App) {
    let read = Jobs::run(cx, |client| async move {
        let view = client.get_logs_config().await.ok()?;
        Some((view, client.get_settings().await.ok()))
    });
    cx.background_executor()
        .spawn(async move {
            if let Some(Some((view, settings))) = read.await {
                configure(&view, settings.as_ref());
            }
        })
        .detach();
}

/// Applies the agent's `/logs/config` view, merged with the committed settings
/// (`committedConfig`) so a stale `full` level is never restored.
fn configure(view: &Value, settings: Option<&Value>) {
    let view = settings.map_or_else(|| view.clone(), |settings| committed(view, settings));
    send(Msg::Configure(view));
}

/// `committedConfig`
fn committed(view: &Value, settings: &Value) -> Value {
    let enabled = settings.get("diagnostics_enabled") != Some(&Value::Bool(false));
    let effective = view.get("effective");
    let pick = |setting: &str, key: &str, default: Value| {
        settings
            .get(setting)
            .filter(|value| !value.is_null())
            .or_else(|| effective.and_then(|found| found.get(key)))
            .cloned()
            .unwrap_or(default)
    };
    let expires = settings
        .get("log_full")
        .and_then(|full| full.get("expires_at"))
        .filter(|value| !value.is_null())
        .or_else(|| view.get("full_expires_at"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut merged = view.clone();
    merged["effective"] = if enabled {
        json!({ "level": pick("log_level", "level", json!("standard")), "category_levels": pick("log_category_levels", "category_levels", json!({})) })
    } else {
        json!({ "level": "standard", "category_levels": {} })
    };
    merged["full_expires_at"] = if enabled { expires } else { Value::Null };
    merged
}

/// `logs.cleared`: drops the queue and every stored segment.
pub(crate) fn clear() {
    send(Msg::Clear);
}

/// `quit`: writes `app.quit`, drains and closes (at most a second).
pub(crate) fn quit() {
    app_log("INFO", "lifecycle", "app.quit", json!({}));
    let (done, wait) = channel();
    send(Msg::Quit(done));
    let _ = wait.recv_timeout(Duration::from_secs(1));
}
