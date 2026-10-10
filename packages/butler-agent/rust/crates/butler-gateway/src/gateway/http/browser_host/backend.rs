//! Which browser serves a call: the attached App, or Butler's own headless
//! browser when no App is attached. A tab stays on the backend that opened
//! it, and a conversation's turn keeps the backend it started with, so a
//! task never switches browsers midway.
use super::{
    HttpError, HttpState, Inner,
    agent_calls::{enforce_result_policy, permitted_url, response, store_still},
};
use axum::response::Response;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Backend {
    App,
    Headless,
}

/// Tab ops go where the tab lives; new tabs follow the turn's pin, then the
/// conversation's live tabs, then the attached App, then headless.
pub(super) fn select(state: &HttpState, hub: &mut Inner, frame: &Value) -> Backend {
    let Some(headless) = state
        .headless
        .as_ref()
        .filter(|h| h.enabled() || h.has_tabs())
    else {
        return Backend::App;
    };
    let op = frame["op"].as_str().unwrap_or("");
    let session = frame["session"].as_str().unwrap_or("");
    // Sign-in is the App's: grants are gateway-local, signed-in tabs exist
    // only in the App browser. Without the App, headless refuses signed-in.
    let signed_in = op == "tab.open"
        && (frame["args"]["signed_in"] == true || frame["args"]["profile"] == "signed_in");
    if op == "signin.grant" || signed_in && hub.host.is_some() {
        return Backend::App;
    }
    if !matches!(op, "tab.open" | "tabs.list" | "owner.closed") {
        let tab = frame["tab"].as_str().unwrap_or("");
        if !hub.tabs.contains(tab) && headless.tab(tab).is_some() {
            return Backend::Headless;
        }
        if !hub.tabs.contains(tab) && hub.host.is_none() && hub.tabs.owned(session).is_empty() {
            return Backend::Headless;
        }
        return Backend::App;
    }
    let turn = frame["turn_id"].as_str().unwrap_or("").to_owned();
    if let Some((pinned_turn, backend)) = hub.pins.get(session)
        && *pinned_turn == turn
    {
        return *backend;
    }
    let backend = if !headless.owned(session).is_empty() {
        Backend::Headless
    } else if !hub.tabs.owned(session).is_empty() || hub.host.is_some() {
        Backend::App
    } else {
        Backend::Headless
    };
    if op == "tab.open" {
        hub.pins.insert(session.to_owned(), (turn, backend));
    }
    backend
}

/// Serves the call on the headless browser when that backend is chosen;
/// otherwise hands the frame back for the App path.
pub(super) async fn route(
    state: &Arc<HttpState>,
    frame: Value,
    op: &str,
    session: &str,
    count: usize,
) -> Result<Result<Response, Value>, HttpError> {
    if op == "owner.closed"
        && let Some(headless) = state.headless.clone()
    {
        headless.close_owner(session).await;
        let attached = state
            .browser
            .0
            .lock()
            .map_err(|_| HttpError::Internal)?
            .host
            .is_some();
        if !attached {
            return response(0, json!({"status":"ok"})).map(Ok);
        }
    }
    let backend = {
        let mut hub = state.browser.0.lock().map_err(|_| HttpError::Internal)?;
        select(state, &mut hub, &frame)
    };
    if backend == Backend::Headless {
        return headless_call(state.clone(), frame, op, session, count)
            .await
            .map(Ok);
    }
    Ok(Err(frame))
}

fn deadline(op: &str, args: &Value) -> u64 {
    match op {
        "tab.open" => 20000,
        "tab.act" => 30000,
        "tab.observe" if args["settle"] == true => 8000,
        _ => 5000,
    }
}

/// One call on the headless browser, behind the same fences as the App's.
pub(super) async fn headless_call(
    state: Arc<HttpState>,
    mut frame: Value,
    op: &str,
    session: &str,
    count: usize,
) -> Result<Response, HttpError> {
    let Some(headless) = state.headless.clone() else {
        return response(count, json!({"status":"unavailable","reason":"no_browser"}));
    };
    let tab_id = frame["tab"].as_str().unwrap_or("").to_owned();
    if !matches!(op, "tab.open" | "tabs.list" | "owner.closed") {
        let owned = headless
            .tab(&tab_id)
            .filter(|tab| tab["owner"] == format!("conversation:{session}").as_str());
        let Some(tab) = owned else {
            return response(
                count,
                json!({"status":"not_dispatched","reason":"not_your_tab","your_tabs":headless.owned(session),
                "recovery":"No tab of this conversation has that id. Retry with one of your_tabs copied exactly (never shorten or retype an id), or call browser_tabs."}),
            );
        };
        if matches!(
            op,
            "tab.observe"
                | "tab.zoom"
                | "tab.screenshot"
                | "tab.prepare"
                | "tab.act"
                | "tab.dialog"
        ) {
            if tab["url"]
                .as_str()
                .is_some_and(|url| !url.is_empty() && !permitted_url(&state, session, url))
            {
                return response(
                    count,
                    json!({"status":"not_dispatched","reason":"navigation_denied"}),
                );
            }
            frame["args"]["policy"] = butler_runtime::browser::navigation_policy(
                &format!("http://127.0.0.1:{}", super::super::content::port(&state)),
                tab["url"].as_str().unwrap_or(""),
            );
            if state
                .previews
                .owned(session, tab["preview"].as_str().unwrap_or(""))
            {
                frame["args"]["policy"]["preview"] = json!(true);
            }
        }
    }
    let limit = deadline(op, &frame["args"]);
    frame["deadline_ms"] = json!(limit);
    frame["id"] = json!(uuid::Uuid::new_v4().to_string());
    let call = headless.execute(frame);
    let mut result = tokio::select! {
        () = state.shutdown.cancelled() => json!({"status":"unknown","reason":"browser_host_lost"}),
        result = tokio::time::timeout(Duration::from_millis(limit + 500), call) => {
            result.unwrap_or_else(|_| json!({"status":"unknown","reason":"timeout"}))
        }
    };
    enforce_result_policy(&state, session, op, &mut result);
    store_still(&state, session, &mut result).await?;
    response(count, result)
}

/// Whether `session` may see `tab` on either backend.
pub(super) fn owns(state: &HttpState, hub: &Inner, session: &str, tab: &str) -> bool {
    hub.tabs.check(session, tab, "tab.observe").is_ok()
        || state
            .headless
            .as_ref()
            .and_then(|h| h.tab(tab))
            .is_some_and(|t| t["owner"] == format!("conversation:{session}").as_str())
}
