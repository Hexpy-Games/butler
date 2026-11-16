//! CDP between the page host and the hosted executor: what may pass either way.
use super::{HttpState, pages::Routes};
use serde_json::{Value, json};
use std::sync::{Arc, Weak};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The app reserves the ids below this on each page for its own DevTools use.
pub(super) const RAW_ID_BASE: u64 = 1 << 30;

/// The only `Target.` methods a page session may call; the rest of that
/// domain and all of `Browser.` could reach other pages or the browser itself.
const TARGET_ALLOWED: &[&str] = &["Target.setAutoAttach", "Target.detachFromTarget"];

/// What to do with one message from the executor.
pub(super) enum Down {
    /// Send to the app's page.
    Page(Value),
    /// Answer the executor here.
    Refuse(Value),
    /// The ids ran out: the link ends.
    Exhausted,
}

fn refusal(id: &Value) -> Down {
    Down::Refuse(json!({"id":id,"error":{"message":"not_available"}}))
}

/// Routes a command of the executor to its page.
pub(super) fn down(routes: &Routes, mut message: Value) -> Down {
    let id = message["id"].clone();
    let method = message["method"].as_str().unwrap_or("");
    let session = message["sessionId"].as_str().map(str::to_owned);
    let fenced = method.starts_with("Browser.")
        || method.starts_with("Target.") && !TARGET_ALLOWED.contains(&method);
    let Some(session) = session.filter(|_| !fenced) else {
        return refusal(&id);
    };
    let tab = if routes.has_tab(&session) {
        if let Some(fields) = message.as_object_mut() {
            fields.remove("sessionId");
        }
        session
    } else if let Some(tab) = routes.child_tab(&session) {
        tab
    } else {
        return refusal(&id);
    };
    if let Some(raw) = id.as_u64() {
        let Some(shifted) = raw
            .checked_add(RAW_ID_BASE)
            .filter(|shifted| i32::try_from(*shifted).is_ok())
        else {
            return Down::Exhausted;
        };
        message["id"] = json!(shifted);
    }
    Down::Page(json!({"tab":tab,"message":message}))
}

/// The message an app entry becomes for the executor; `None` drops it.
pub(super) fn up(routes: &Routes, entry: &Value) -> Option<Value> {
    let mut message = entry["message"].clone();
    if !message.is_object() {
        return None;
    }
    let Some(tab) = entry["tab"].as_str() else {
        return host_event(routes, message);
    };
    if !routes.has_tab(tab) {
        return None;
    }
    if let Some(id) = message["id"].as_u64() {
        message["id"] = json!(id.checked_sub(RAW_ID_BASE)?);
    }
    if message.get("sessionId").is_none() {
        message["sessionId"] = json!(tab);
    }
    let params = &message["params"];
    match message["method"].as_str() {
        Some("Target.attachedToTarget") if params["targetInfo"]["type"] != "page" => {
            routes.add_child(params["sessionId"].as_str()?, tab);
        }
        Some("Target.detachedFromTarget") => routes.remove_child(params["sessionId"].as_str()?),
        _ => {}
    }
    Some(message)
}

/// The events the app makes for itself, outside any page.
fn host_event(routes: &Routes, message: Value) -> Option<Value> {
    let params = &message["params"];
    match message["method"].as_str()? {
        "Target.attachedToTarget" if params["targetInfo"]["type"] == "page" => {
            let target = params["targetInfo"]["targetId"].as_str()?;
            routes.add_tab(params["sessionId"].as_str()?, target);
        }
        "Target.targetDestroyed" => routes.remove_target(params["targetId"].as_str()?),
        "Target.targetInfoChanged" | "Target.targetCrashed" => {}
        _ => return None,
    }
    Some(message)
}

/// Everything the executor-to-app driver works with.
pub(super) struct Pump {
    pub from_executor: mpsc::Receiver<Vec<u8>>,
    pub to_executor: mpsc::Sender<Vec<u8>>,
    pub to_app: mpsc::Sender<Value>,
    pub routes: Arc<Routes>,
    pub state: Weak<HttpState>,
    pub generation: u64,
    pub shutdown: CancellationToken,
}

/// Reads the executor's NUL-framed commands and sends each where `down` says.
pub(super) async fn run_down(mut pump: Pump) {
    let mut buffer = Vec::new();
    loop {
        let chunk = tokio::select! {
            () = pump.shutdown.cancelled() => return,
            chunk = pump.from_executor.recv() => chunk,
        };
        let Some(chunk) = chunk else { return };
        buffer.extend_from_slice(&chunk);
        while let Some(end) = buffer.iter().position(|byte| *byte == 0) {
            let raw: Vec<u8> = buffer.drain(..=end).collect();
            let Ok(message) = serde_json::from_slice::<Value>(&raw[..end]) else {
                continue;
            };
            match down(&pump.routes, message) {
                Down::Page(frame) => {
                    if pump.to_app.send(frame).await.is_err() {
                        return;
                    }
                }
                Down::Refuse(answer) => {
                    let mut bytes = answer.to_string().into_bytes();
                    bytes.push(0);
                    if pump.to_executor.send(bytes).await.is_err() {
                        return;
                    }
                }
                Down::Exhausted => {
                    if let Some(state) = pump.state.upgrade() {
                        super::detach_generation(&state, pump.generation);
                    }
                    return;
                }
            }
        }
    }
}
