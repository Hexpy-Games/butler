//! The harness as the App (`--app`): the lifecycle starts and supervises the Agent as `main.rs`
//! does, and these commands report what the supervisor did. `agent <state>` waits for the Agent
//! state the windows show; `restart` is the tray's Restart and `restart-answers` waits for what
//! each one answered; `diagnostics <name>` and `app-quit` (Quit, then the Agent's exit) write
//! `<name>.json` with the supervisor's diagnostics and every state shown so far.
use super::{Harness, lifecycle, settle};
use anyhow::{Context as _, bail};
use gpui::{App, Global};
use lifecycle::supervisor::{AgentState, Supervisor};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Every Agent state the windows were shown, in order.
#[derive(Default)]
struct Seen(Vec<AgentState>);

impl Global for Seen {}

/// The answer of every `restart` command, once the supervisor gives it.
#[derive(Default)]
struct Restarts(Vec<Answer>);

type Answer = Arc<Mutex<Option<Result<(), String>>>>;

impl Global for Restarts {}

/// `main.rs`'s startup before the window: the App's lifecycle and the Agent, without the window
/// and tray rules.
pub(super) fn start(cx: &mut App, data: &Path) {
    let legacy = lifecycle::legacy_data(data);
    lifecycle::start(cx, data.to_path_buf(), legacy);
    if let Some(runtime) = lifecycle::runtime(cx) {
        cx.observe(&runtime, |runtime, cx| {
            let state = runtime.read(cx).state;
            cx.default_global::<Seen>().0.push(state);
        })
        .detach();
    }
    if !legacy {
        lifecycle::ensure_ready(cx);
    }
}

pub(super) fn command(h: &mut Harness, dir: &Path, command: &str, arg: &str) -> anyhow::Result<()> {
    match command {
        "agent" => until(h, Duration::from_secs(120), |h| {
            Ok(h.cx
                .update(|cx| lifecycle::runtime(cx).is_some_and(|r| name(r.read(cx).state) == arg)))
        }),
        "restart" => {
            h.cx.update(|cx| {
                let slot = Arc::new(Mutex::new(None));
                cx.default_global::<Restarts>().0.push(slot.clone());
                let answer = lifecycle::run(cx, Supervisor::restart);
                cx.spawn(async move |_| {
                    let answer = answer.await.map_err(|error| format!("{error:?}"));
                    if let Ok(mut slot) = slot.lock() {
                        *slot = Some(answer);
                    }
                })
                .detach();
            });
            Ok(())
        }
        // Waits for every Restart's answer and writes them (`ok` or the error) to `restarts.json`.
        "restart-answers" => {
            let slots = h.cx.update(|cx| cx.default_global::<Restarts>().0.clone());
            until(h, Duration::from_secs(120), |_| {
                Ok(slots
                    .iter()
                    .all(|slot| slot.lock().is_ok_and(|a| a.is_some())))
            })?;
            let answers: Vec<String> = slots
                .iter()
                .filter_map(|slot| slot.lock().ok()?.clone())
                .map(|answer| answer.err().unwrap_or_else(|| "ok".to_owned()))
                .collect();
            std::fs::write(dir.join("restarts.json"), serde_json::to_vec(&answers)?)?;
            Ok(())
        }
        "diagnostics" => report(h, dir, arg),
        "app-quit" => {
            h.cx.update(lifecycle::quit);
            // Quit is done once our child has exited (end of its lease, or the kill at 8 s).
            until(h, Duration::from_secs(20), |h| {
                let d = diagnostics(h)?;
                Ok(d["pid"].is_null() && d["phase"] == "stopped" && !d["last_exit"].is_null())
            })?;
            report(h, dir, "app-quit")
        }
        _ => bail!("unknown app command"),
    }
}

fn name(state: AgentState) -> String {
    format!("{state:?}").to_lowercase()
}

/// Real time passes (the supervisor runs on its own thread) until `done`, for at most `limit`.
fn until(
    h: &mut Harness,
    limit: Duration,
    mut done: impl FnMut(&mut Harness) -> anyhow::Result<bool>,
) -> anyhow::Result<()> {
    let deadline = Instant::now() + limit;
    loop {
        settle(&mut h.cx, h.handle);
        if done(h)? {
            return Ok(());
        }
        if Instant::now() > deadline {
            bail!("app state deadline");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn diagnostics(h: &mut Harness) -> anyhow::Result<serde_json::Value> {
    let mut answer =
        h.cx.update(|cx| lifecycle::runtime(cx).map(|r| r.read(cx).supervisor.diagnostics()))
            .context("no App lifecycle (start with --app)")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = answer.try_recv()? {
            return Ok(value);
        }
        if Instant::now() > deadline {
            bail!("supervisor did not answer");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn report(h: &mut Harness, dir: &Path, file: &str) -> anyhow::Result<()> {
    let diagnostics = diagnostics(h)?;
    let states: Vec<String> = h.cx.update(|cx| {
        cx.try_global::<Seen>()
            .map(|seen| seen.0.iter().copied().map(name).collect())
            .unwrap_or_default()
    });
    let report = serde_json::json!({ "diagnostics": diagnostics, "states": states });
    std::fs::write(
        dir.join(format!("{file}.json")),
        serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}
