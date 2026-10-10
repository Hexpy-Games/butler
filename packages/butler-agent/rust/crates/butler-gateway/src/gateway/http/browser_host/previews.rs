//! Main-only transport for reviewed preview effects.
use super::{HttpError, HttpState, error};
use axum::{http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn call(state: Arc<HttpState>, frame: Value) -> Result<Response, HttpError> {
    let session = frame["session"]
        .as_str()
        .ok_or_else(|| error(400, "invalid_session"))?;
    let args = &frame["args"];
    let agent = args["agent"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| error(400, "invalid_agent"))?;
    let id = args["preview_id"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
        .ok_or_else(|| error(400, "invalid_preview"))?;
    let result = match frame["op"].as_str() {
        Some("preview.start") => start(&state, session, agent, id, args).await,
        Some("preview.stop") => {
            let result = state.previews.stop(session, agent, id).await;
            if result.is_ok()
                && let Ok(hub) = state.browser.0.lock()
                && let Some(host) = &hub.host
            {
                let _ = host.try_send(json!({"id":uuid::Uuid::new_v4().to_string(),"op":"preview.closed","session":session,"args":{"preview_id":id}}));
            }
            result
        }
        _ => Err("invalid_preview_op"),
    };
    super::super::json(
        StatusCode::OK,
        result.unwrap_or_else(|reason| json!({"status":"not_dispatched","reason":reason})),
    )
}
async fn start(
    state: &Arc<HttpState>,
    session: &str,
    agent: &str,
    id: &str,
    args: &Value,
) -> Result<Value, &'static str> {
    let port = args["port"].as_u64().unwrap_or(0);
    if [
        u64::from(state.remote.primary().port()),
        u64::from(super::super::content::port(state)),
    ]
    .contains(&port)
    {
        return Err("invalid_port");
    }
    let mut result = state.previews.start(session, agent, id, args).await?;
    let origin = format!("http://127.0.0.1:{}", super::super::content::port(state));
    let url = super::super::content::preview::url(state, &origin, id)
        .map_err(|_| "preview_unavailable")?;
    result["url"] = json!(url);
    let frame = json!({"op":"tab.open","session":session,"args":{"url":url,"preview_id":id}});
    let opened = super::agent_calls::call(state.clone(), frame).await;
    if let Ok(opened) = opened {
        let bytes = axum::body::to_bytes(opened.into_body(), 64 * 1024)
            .await
            .map_err(|_| "preview_unavailable")?;
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            result["browser"] = value;
        }
    }
    Ok(result)
}

pub(in crate::gateway::http) fn observe_lifetime(state: &Arc<HttpState>) -> Result<(), HttpError> {
    let weak = Arc::downgrade(state);
    let runtime = tokio::runtime::Handle::current();
    let events = state.application.subscribe_events(Arc::new(move |event| {
        let envelope = event.envelope();
        if !matches!(
            envelope.event_type.as_str(),
            "session.updated" | "session.permanently_deleted"
        ) {
            return;
        }
        let Some(session) = envelope.payload.get("session") else {
            return;
        };
        if session["archived"] != true && envelope.event_type != "session.permanently_deleted" {
            return;
        }
        let Some(id) = session["id"].as_str().map(str::to_owned) else {
            return;
        };
        if let Some(state) = weak.upgrade() {
            state.previews.close(&id);
            runtime.spawn(async move {
                state.previews.stop_closed(&id).await;
            });
        }
    }))?;
    let state = state.clone();
    tokio::spawn(async move {
        state.shutdown.cancelled().await;
        state.previews.shutdown();
        drop(events);
    });
    Ok(())
}
