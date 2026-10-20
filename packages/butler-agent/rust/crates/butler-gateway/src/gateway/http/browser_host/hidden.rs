//! The hidden App host: the installed App's Electron without a window (see
//! `butler_runtime::browser::app_host`). It attaches over this same channel,
//! so the App path serves its calls with the App's own executor.
//!
//! Here it is started on the first browser need while no host is attached,
//! handed over when the App itself attaches (at once when idle, otherwise
//! after its current task), kept from what needs the user at the App, and
//! reaped by the headless rule: 60 s after its last tab.
use super::{HttpError, HttpState, Inner, backend::Backend, error};
use axum::http::HeaderMap;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Weak},
    time::{Duration, Instant},
};

/// The launch id a hidden host attaches with; the App sends none.
const LAUNCH_HEADER: &str = "x-butler-browser-host";
const REAP_AFTER: Duration = Duration::from_secs(60);

pub(super) fn launch_of(headers: &HeaderMap) -> Option<String> {
    headers
        .get(LAUNCH_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// Whether the attached hidden host still serves a task: a call in flight or
/// a turn that used it and has not ended.
fn busy(hub: &Inner) -> bool {
    hub.still_backlog > 0
        || !hub.pending.is_empty()
        || !hub.turns.is_empty()
        || hub
            .tabs
            .ready_waits()
            .iter()
            .any(|tab| tab["inUse"] == true)
}

/// Admits an attach. The hidden host only as the launch the agent started,
/// into a free channel; the App also takes the channel from an idle hidden
/// host, and waits (409, it retries) while that host finishes its task.
pub(super) fn admit(
    state: &HttpState,
    hub: &mut Inner,
    launch: Option<&str>,
) -> Result<(), HttpError> {
    if hub.retiring {
        return Err(error(409, "browser_host_busy"));
    }
    if let Some(launch) = launch {
        let ours = state.app_host.as_ref().is_some_and(|h| h.admit(launch));
        if !ours {
            return Err(error(403, "browser_host_forbidden"));
        }
        if hub.host.is_some() {
            return Err(error(409, "browser_host_exists"));
        }
        return Ok(());
    }
    if hub.host.is_none() {
        return Ok(());
    }
    if !hub.hidden {
        return Err(error(409, "browser_host_exists"));
    }
    if busy(hub) {
        hub.app_waiting = true;
        return Err(error(409, "browser_host_busy"));
    }
    retire(state, hub);
    Err(error(409, "browser_host_busy"))
}

/// Ends the hidden host: its channel closes (it quits on its own) and its
/// process tree is ended after a grace period.
fn retire(state: &HttpState, hub: &mut Inner) {
    if hub.hidden {
        detached(state, hub);
    }
}

/// The channel ended. Settle all indexed pending receipts and join the retired
/// process before admitting another host that could replay its outbox.
pub(super) fn detached(state: &HttpState, hub: &mut Inner) {
    let host = hub.hidden.then(|| state.app_host.clone()).flatten();
    hub.detach();
    hub.retiring = true;
    state.browser.2.notify_waiters();
    let application = state.application.clone();
    let browser = state.browser.clone();
    tokio::spawn(async move {
        let _ = application
            .browser_still(crate::gateway::AppBrowserStillCommand::SettlePending {
                reason: "browser_host_lost".into(),
            })
            .await;
        browser.4.notify_waiters();
        if let Some(host) = host {
            host.stop().await;
        }
        if let Ok(mut hub) = browser.0.lock() {
            hub.retiring = false;
        }
        browser.2.notify_waiters();
    });
}

/// Hands the channel to a waiting App once the hidden host's task ended.
pub(super) fn hand_over(state: &HttpState, hub: &mut Inner) {
    if hub.hidden && hub.app_waiting && !busy(hub) {
        retire(state, hub);
    }
}

/// What the hidden host cannot do without a user at the App: a hand-over to
/// the user, and signed-in browsing (the App's own profile).
pub(super) fn refusal(state: &HttpState, frame: &Value, op: &str) -> Option<Value> {
    if !state.browser.0.lock().is_ok_and(|hub| hub.hidden) {
        return None;
    }
    if op == "tab.wait" {
        return Some(json!({"status":"unavailable","reason":"app_required",
            "recovery":"Background browser cannot hand a tab to the user. Ask the user to open the Butler App, then reopen the page and call browser_wait_for_user."}));
    }
    let signed_in = frame["args"]["signed_in"] == true || frame["args"]["profile"] == "signed_in";
    if op == "tab.open" && signed_in || op.starts_with("signin.") && op != "signin.grant" {
        return Some(json!({"status":"refused","reason":"signed_in_unavailable"}));
    }
    None
}

/// Starts the hidden host for a new tab (or an output check, `frame`
/// `None`) while no host is attached, unless the turn already runs on
/// Chrome. The App's engine is available independently of the operator's
/// Chrome fallback setting.
pub(super) async fn ensure(state: &Arc<HttpState>, frame: Option<&Value>) {
    let (Some(app_host), Some(headless)) = (state.app_host.clone(), state.headless.as_ref()) else {
        return;
    };
    if let Some(frame) = frame {
        let session = frame["session"].as_str().unwrap_or("");
        let signed_in =
            frame["args"]["signed_in"] == true || frame["args"]["profile"] == "signed_in";
        if signed_in || !headless.owned(session).is_empty() {
            return;
        }
    }
    let credentials = {
        let Ok(hub) = state.browser.0.lock() else {
            return;
        };
        let turn = frame.and_then(|f| f["turn_id"].as_str()).unwrap_or("");
        let session = frame.and_then(|f| f["session"].as_str()).unwrap_or("");
        let on_headless = hub
            .pins
            .get(session)
            .is_some_and(|(pinned, backend)| pinned == turn && *backend == Backend::Headless);
        if hub.host.is_some() || on_headless {
            return;
        }
        let (Some(token), Some(admin)) = (state.security.token(), state.security.admin()) else {
            return;
        };
        butler_runtime::browser::HostCredentials {
            url: format!("http://127.0.0.1:{}", state.security.port()),
            token: token.to_string(),
            admin: admin.to_string(),
        }
    };
    if app_host.available().await {
        let _ = app_host.start(credentials).await;
    }
}

/// Reaps the hidden host of attach `generation`: 60 s after it holds no tab
/// and no call, or at once when its process ended.
pub(super) fn watch(state: &Arc<HttpState>, generation: u64) {
    let ended = state.app_host.as_ref().and_then(|h| h.ended());
    let shutdown = state.shutdown.clone();
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        let mut ended = ended;
        let mut idle_since: Option<Instant> = None;
        loop {
            let Some(state) = weak.upgrade() else { return };
            let changed = state.browser.2.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let idle = match state.browser.0.lock() {
                Ok(hub) if hub.generation == generation && hub.hidden => {
                    hub.tabs.is_empty() && !busy(&hub)
                }
                _ => return,
            };
            idle_since = if idle {
                idle_since.or(Some(Instant::now()))
            } else {
                None
            };
            let reap = async {
                match idle_since {
                    Some(since) => tokio::time::sleep_until((since + REAP_AFTER).into()).await,
                    None => std::future::pending().await,
                }
            };
            let exited = async {
                match ended.as_mut() {
                    Some(ended) => drop(ended.wait_for(|ended| *ended).await),
                    None => std::future::pending().await,
                }
            };
            let idle_now = tokio::select! {
                () = shutdown.cancelled() => return,
                () = &mut changed => continue,
                () = reap => true,
                () = exited => false,
            };
            if reap_generation(&weak, generation, idle_now) {
                return;
            }
        }
    });
}

/// Retires attach `generation` (when `idle`, only if it still holds no tab
/// and no call); `false` when it is busy again.
fn reap_generation(weak: &Weak<HttpState>, generation: u64, idle: bool) -> bool {
    let Some(state) = weak.upgrade() else {
        return true;
    };
    let Ok(mut hub) = state.browser.0.lock() else {
        return true;
    };
    if hub.generation != generation {
        return true;
    }
    if idle && (busy(&hub) || !hub.tabs.is_empty()) {
        return false;
    }
    retire(&state, &mut hub);
    true
}
