//! Call-scoped execution uses. Tab permission is deliberately unaffected.
use super::{HttpError, HttpState, Inner, error};
use serde_json::{Map, Value, json};
use std::sync::Arc;
use tokio::sync::oneshot;

pub(super) struct Use {
    pub session: String,
    pub turn: Option<String>,
    pub call: Option<String>,
    tab: Value,
}
fn executes(op: &str) -> bool {
    matches!(
        op,
        "tab.open"
            | "tab.observe"
            | "tab.screenshot"
            | "tab.prepare"
            | "tab.act"
            | "tab.dialog"
            | "tab.close"
    )
}
pub(super) fn dispatch(
    hub: &mut Inner,
    frame: Value,
    sender: oneshot::Sender<Value>,
) -> Result<(), HttpError> {
    let id = frame["id"].as_str().ok_or(HttpError::Internal)?.to_owned();
    let active = executes(frame["op"].as_str().unwrap_or(""));
    let host = hub.host.as_ref().ok_or_else(|| error(503, "no_browser"))?;
    if host.capacity() < if active { 2 } else { 1 } {
        return Err(error(429, "browser_busy"));
    }
    if let (Some(session), Some(turn)) = (frame["session"].as_str(), frame["turn_id"].as_str()) {
        hub.turns.insert((session.into(), turn.into()));
    }
    if active {
        host.try_send(json!({"id":id,"op":"use.started","session":frame["session"],"turn_id":frame["turn_id"],"tab":frame["tab"],"args":{}}))
            .map_err(|_| error(429,"browser_busy"))?;
        hub.uses.insert(
            id.clone(),
            Use {
                session: frame["session"].as_str().unwrap_or("").into(),
                turn: frame["turn_id"].as_str().map(str::to_owned),
                call: frame["call_id"].as_str().map(str::to_owned),
                tab: frame["tab"].clone(),
            },
        );
    }
    if host.try_send(frame).is_err() {
        // A failed control delivery closes the stream; the App resets on loss.
        hub.host = None;
        hub.pending.clear();
        hub.uses.clear();
        hub.turns.clear();
        return Err(error(429, "browser_busy"));
    }
    hub.pending.insert(id, sender);
    Ok(())
}
pub(super) fn release(hub: &mut Inner, id: &str) {
    let abort = hub.pending.remove(id).is_some();
    end(hub, id, abort);
}
fn end(hub: &mut Inner, id: &str, abort: bool) {
    let Some(use_) = hub.uses.remove(id) else {
        return;
    };
    let frame = json!({"op":"use.ended","session":use_.session,"turn_id":use_.turn,"tab":use_.tab,"args":{"id":id,"abort":abort}});
    send(hub, frame);
}
fn send(hub: &mut Inner, frame: Value) {
    if hub
        .host
        .as_ref()
        .is_some_and(|host| host.try_send(frame).is_err())
    {
        hub.host = None;
        hub.pending.clear();
        hub.uses.clear();
        hub.turns.clear();
    }
}
pub(super) fn cancel(state: &Arc<HttpState>, session: &str, call: &str) -> Result<(), HttpError> {
    let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
    let ids: Vec<_> = hub
        .uses
        .iter()
        .filter(|(_, u)| u.session == session && u.call.as_deref() == Some(call))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        // Keep the response channel so native batch receipts retain completed steps.
        end(&mut hub, &id, true);
    }
    Ok(())
}
pub(super) fn finish_turn(state: &HttpState, payload: &Map<String, Value>) {
    let turn = payload
        .get("turn")
        .and_then(Value::as_object)
        .unwrap_or(payload);
    let status = turn.get("state").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        status,
        "delivered" | "cancelled" | "failed" | "runtime_fault" | "cancelling"
    ) {
        return;
    }
    let session = turn
        .get("chat_id")
        .or_else(|| turn.get("session_id"))
        .and_then(Value::as_str);
    let id = turn
        .get("id")
        .or_else(|| turn.get("turn_id"))
        .and_then(Value::as_str);
    let (Some(session), Some(turn_id)) = (session, id) else {
        return;
    };
    finish_owner_turn(state, session, turn_id);
}
pub(super) fn finish_child(
    state: std::sync::Weak<HttpState>,
    runtime: &tokio::runtime::Handle,
    payload: &Map<String, Value>,
) {
    let Some(child) = payload.get("child_session_id").and_then(Value::as_str) else {
        return;
    };
    let child = child.to_owned();
    runtime.spawn(async move {
        let Some(state) = state.upgrade() else { return };
        let Ok(projection) = state.application.subsession_projection(child).await else {
            return;
        };
        let turn = &projection["latest_turn"];
        if projection["terminal"] != true
            && !matches!(
                turn["state"].as_str(),
                Some("delivered" | "cancelled" | "failed" | "runtime_fault")
            )
        {
            return;
        }
        let Some(id) = turn["id"].as_str() else {
            return;
        };
        // The dispatch stored the trusted public owner, including nested children.
        let session = state.browser.0.lock().ok().and_then(|hub| {
            hub.turns
                .iter()
                .find(|(_, turn)| turn == id)
                .map(|(owner, _)| owner.clone())
        });
        if let Some(session) = session {
            finish_owner_turn(&state, &session, id);
        }
    });
}
fn finish_owner_turn(state: &HttpState, session: &str, turn_id: &str) {
    if let Ok(mut hub) = state.browser.0.lock() {
        if !hub.turns.remove(&(session.into(), turn_id.into())) {
            return;
        }
        let ids: Vec<_> = hub
            .uses
            .iter()
            .filter(|(_, u)| u.session == session && u.turn.as_deref() == Some(turn_id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            release(&mut hub, &id);
        }
        send(
            &mut hub,
            json!({"op":"use.finished","session":session,"turn_id":turn_id,"args":{}}),
        );
    }
}
