//! Session-bound v2 dispatch. Both ownership fences precede native dispatch.
use super::{HttpError, HttpState, PendingCall, error};
use axum::{http::StatusCode, response::Response};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

pub(super) async fn call(state: Arc<HttpState>, mut frame: Value) -> Result<Response, HttpError> {
    let op = frame["op"].as_str().unwrap_or("").to_owned();
    let session = frame["session"].as_str().unwrap_or("").to_owned();
    validate(&state, &mut frame, &op, &session)?;
    let deadline = match op.as_str() {
        "tab.open" => 20000,
        "tab.act" => 30000,
        _ => 5000,
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        if !matches!(op.as_str(), "tab.open" | "tabs.list" | "owner.closed")
            && let Err(reason) = hub
                .tabs
                .check(&session, frame["tab"].as_str().unwrap_or(""), &op)
        {
            return super::super::json(
                StatusCode::OK,
                json!({"status":"not_dispatched","reason":reason}),
            );
        }
        if matches!(
            op.as_str(),
            "tab.observe" | "tab.prepare" | "tab.act" | "tab.dialog"
        ) {
            let tab = hub
                .tabs
                .check(&session, frame["tab"].as_str().unwrap_or(""), &op)
                .map_err(|_| error(403, "not_your_tab"))?;
            if tab["url"]
                .as_str()
                .is_some_and(|url| !permitted_url(&state, url))
            {
                return super::super::json(
                    StatusCode::OK,
                    json!({"status":"not_dispatched","reason":"navigation_denied"}),
                );
            }
            frame["args"]["policy"] = json!({"content_origin":format!("http://127.0.0.1:{}",super::super::content::port(&state)),"secure_keypads":butler_runtime::browser::SECURE_KEYPAD_MARKERS});
        }
        let Some(host) = hub.host.as_ref() else {
            return super::super::json(
                StatusCode::OK,
                json!({"status":"unavailable","reason":"no_browser"}),
            );
        };
        if hub.pending.len() >= 8 {
            return Err(error(429, "browser_busy"));
        }
        frame["id"] = json!(id);
        frame["deadline_ms"] = json!(deadline);
        host.try_send(frame)
            .map_err(|_| error(429, "browser_busy"))?;
        hub.pending.insert(id.clone(), sender);
    }
    let _pending = PendingCall {
        state: state.clone(),
        id,
    };
    let mut result = tokio::select! {
        () = state.shutdown.cancelled() => json!({"status":"unknown","reason":"browser_host_lost"}),
        result = tokio::time::timeout(Duration::from_millis(deadline + 500),receiver) => match result {
            Ok(Ok(value)) => value,
            Ok(Err(_)) => json!({"status":"unknown","reason":"browser_host_lost"}),
            Err(_) => json!({"status":"unknown","reason":"timeout"}),
        }
    };
    enforce_result_policy(&state, &session, &op, &mut result);
    store_still(&state, &session, &mut result).await?;
    super::super::json(StatusCode::OK, result)
}
fn permitted_url(state: &HttpState, raw: &str) -> bool {
    butler_runtime::browser::public_url(raw).is_ok()
        || url::Url::parse(raw).is_ok_and(|u| {
            u.scheme() == "http"
                && u.username().is_empty()
                && u.password().is_none()
                && u.host_str() == Some("127.0.0.1")
                && u.port() == Some(super::super::content::port(state))
                && u.path().starts_with("/__o/")
        })
}
fn enforce_result_policy(state: &HttpState, session: &str, op: &str, result: &mut Value) {
    let denied = result
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| !permitted_url(state, url))
        || result
            .get("frames")
            .and_then(Value::as_array)
            .is_some_and(|frames| {
                frames.iter().any(|frame| {
                    frame
                        .as_str()
                        .or_else(|| frame["url"].as_str())
                        .is_none_or(|url| !permitted_url(state, url))
                })
            });
    if !denied {
        return;
    }
    if let Some(tab) = result.get("tab").and_then(Value::as_str)
        && let Ok(hub) = state.browser.0.lock()
        && let Some(host) = &hub.host
    {
        let _ = host.try_send(json!({"id":uuid::Uuid::new_v4().to_string(),"op":"tab.close","session":session,"tab":tab,"args":{},"deadline_ms":5000}));
    }
    *result = json!({"status":if op == "tab.act" {"unknown"} else {"not_dispatched"},"reason":"navigation_denied"});
}
fn validate(
    state: &HttpState,
    frame: &mut Value,
    op: &str,
    session: &str,
) -> Result<(), HttpError> {
    if session.is_empty()
        || session.len() > 128
        || !session
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(error(400, "invalid_session"));
    }
    if !matches!(
        op,
        "tab.open"
            | "tab.observe"
            | "tab.prepare"
            | "tab.act"
            | "tab.dialog"
            | "tab.close"
            | "tabs.list"
            | "tab.wait"
            | "tab.waiting"
            | "tab.cancel"
            | "owner.closed"
    ) {
        return Err(error(400, "invalid_browser_op"));
    }
    if op == "tab.open" {
        let raw = frame["args"]["url"].as_str().unwrap_or("");
        let content = url::Url::parse(raw).ok().filter(|u| {
            u.host_str() == Some("127.0.0.1")
                && u.port() == Some(super::super::content::port(state))
                && u.path().starts_with("/__o/")
        });
        let url = match content {
            Some(url) => url,
            None => butler_runtime::browser::public_url(raw)
                .map_err(|_| error(400, "navigation_denied"))?,
        };
        frame["args"]["policy"] = json!({"content_origin":format!("http://127.0.0.1:{}",super::super::content::port(state)),"secure_keypads":butler_runtime::browser::SECURE_KEYPAD_MARKERS,"sites":[butler_runtime::browser::site_scope(url.as_str()).map_err(|_|error(400,"navigation_denied"))?]});
    }
    if op == "tab.act"
        && frame["args"]["steps"]
            .as_array()
            .is_none_or(|s| s.is_empty() || s.len() > 10)
    {
        return Err(error(400, "invalid_steps"));
    }
    Ok(())
}
pub(super) async fn events(state: Arc<HttpState>, value: Value) -> Result<Response, HttpError> {
    let tabs = value["tabs"]
        .as_array()
        .ok_or_else(|| error(400, "invalid_snapshot"))?;
    let handed_back = {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        let changed: Vec<Value> = tabs
            .iter()
            .filter(|tab| {
                let id = tab["id"].as_str().unwrap_or("");
                tab["holder"] == "agent"
                    && (hub.tabs.is_user(id) || tab["waiting"] == true && !hub.tabs.is_waiting(id))
            })
            .cloned()
            .collect();
        hub.tabs
            .replace(tabs)
            .map_err(|_| error(400, "invalid_snapshot"))?;
        changed
    };
    resume_waits(&state, &handed_back).await?;
    super::super::json(StatusCode::OK, json!({"ok":true}))
}
pub(super) async fn resume_waits(state: &HttpState, tabs: &[Value]) -> Result<(), HttpError> {
    for tab in tabs {
        let Some(session) = tab["owner"]
            .as_str()
            .and_then(|s| s.strip_prefix("conversation:"))
        else {
            continue;
        };
        let owner = crate::gateway::application::app_session_hint(session);
        let requests = state.application.authority_list(owner.clone()).await?;
        for request in requests
            .requests
            .iter()
            .filter(|r| r["executable"] == "browser_wait_for_user")
        {
            // Only the requested tab's hand-back resumes its durable nonterminal wait.
            if request["approval"]["operation"]["targets"]
                .as_array()
                .is_some_and(|targets| targets.iter().any(|t| t == &tab["id"]))
            {
                state
                    .application
                    .authority_decide(crate::gateway::AppAuthorityDecisionInput {
                        owner_session_id: owner.clone(),
                        request_ref: request["request_ref"].as_str().unwrap_or("").into(),
                        action: "allow".into(),
                        allow_scope: Some("once".into()),
                        alternative_input: None,
                    })
                    .await?;
            }
        }
    }
    Ok(())
}
pub(in crate::gateway::http) fn close_owner(state: &HttpState, session: &str) {
    if let Ok(hub) = state.browser.0.lock()
        && let Some(host) = &hub.host
    {
        let _ = host.try_send(json!({"id":uuid::Uuid::new_v4().to_string(),"op":"owner.closed","session":session,"args":{},"deadline_ms":5000}));
    }
}

pub(super) async fn still(state: Arc<HttpState>, mut value: Value) -> Result<Response, HttpError> {
    let session = value["session"].as_str().unwrap_or("").to_owned();
    {
        let hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        hub.tabs
            .check(&session, value["tab"].as_str().unwrap_or(""), "tab.observe")
            .map_err(|_| error(403, "not_your_tab"))?;
    }
    upload_still(&state, &session, &mut value).await?;
    super::super::json(StatusCode::OK, json!({"still_file":value["still_file"]}))
}
async fn store_still(
    state: &HttpState,
    session: &str,
    result: &mut Value,
) -> Result<(), HttpError> {
    let tab = result["tab"].clone();
    upload_still(state, session, result).await?;
    let mut latest = result.get("still_file").cloned();
    if let Some(steps) = result.get_mut("steps").and_then(Value::as_array_mut) {
        for step in steps.iter_mut().take(10) {
            step["tab"] = tab.clone();
            upload_still(state, session, step).await?;
            if let Some(file) = step.get("still_file") {
                latest = Some(file.clone());
            }
        }
    }
    if let Some(file) = latest {
        result["still_file"] = file;
    }
    Ok(())
}
async fn upload_still(
    state: &HttpState,
    session: &str,
    result: &mut Value,
) -> Result<(), HttpError> {
    use base64::Engine;
    let Some(still) = result.as_object_mut().and_then(|r| r.remove("still")) else {
        return Ok(());
    };
    let Some(raw) = still["base64"].as_str().filter(|s| s.len() <= 32768) else {
        return Ok(());
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) else {
        return Ok(());
    };
    if bytes.len() > 24 * 1024 {
        return Ok(());
    }
    let _exclusive = state.browser.1.lock().await;
    let file = state
        .application
        .upload_message_file(crate::gateway::AppFileUpload {
            browser_tab: Some(result["tab"].as_str().unwrap_or("").into()),
            owner_session_id: Some(session.into()),
            name: "browser-step.jpg".into(),
            mime_type: Some("image/jpeg".into()),
            bytes: bytes.into(),
        })
        .await?;
    result["still_file"] = serde_json::to_value(file).map_err(|_| HttpError::Internal)?;
    Ok(())
}
