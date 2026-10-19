//! Change-driven waiting for a single act's bounded desktop evidence projection.
use super::*;
use crate::gateway::AppBrowserStillCommand as C;
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if request.method() != Method::GET {
        return Err(HttpError::public(
            405,
            "method_not_allowed",
            "Method not allowed.",
        ));
    }
    let id = request
        .uri()
        .path()
        .strip_prefix("/browser-stills/")
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| HttpError::public(400, "invalid_act", "Invalid act."))?
        .to_owned();
    let args = query(request.uri());
    let session = args.get("session_id").cloned().unwrap_or_default();
    read(
        &state,
        &id,
        &session,
        args.get("wait").is_some_and(|v| v == "1"),
    )
    .await
    .and_then(|value| {
        json(
            StatusCode::OK,
            serde_json::json!({"protocol_version":APP_PROTOCOL_VERSION,"data":value}),
        )
    })
}

async fn read(
    state: &HttpState,
    id: &str,
    session: &str,
    wait: bool,
) -> Result<serde_json::Value, HttpError> {
    let until = tokio::time::Instant::now() + std::time::Duration::from_secs(25);
    loop {
        let changed = state.browser.4.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let value = state
            .application
            .browser_still(C::Read {
                id: id.into(),
                session: session.into(),
            })
            .await?;
        if value["complete"] == true || !wait || tokio::time::Instant::now() >= until {
            return Ok(value);
        }
        tokio::select! {
            _ = tokio::time::timeout_at(until, changed) => (),
            () = state.shutdown.cancelled() => return Err(HttpError::public(503, "gateway_closing", "Gateway closing.")),
        }
    }
}

/// Late desktop evidence accompanies the exact raw output without changing its bytes or pagination.
pub(super) async fn for_output(
    state: &HttpState,
    content: &str,
) -> Result<Option<serde_json::Value>, HttpError> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else {
        return Ok(None);
    };
    if !matches!(
        value["schema"].as_str(),
        Some("butler.browser-action.v1" | "butler.browser-observation.v1")
    ) {
        return Ok(None);
    }
    let Some((id, session)) = marker(&value, 0) else {
        return Ok(None);
    };
    if uuid::Uuid::parse_str(id).is_err() {
        return Ok(None);
    }
    read(state, id, session, true).await.map(Some)
}

fn marker(value: &serde_json::Value, depth: usize) -> Option<(&str, &str)> {
    if depth > 8 {
        return None;
    }
    if let Some(pending) = value.get("still_pending") {
        return Some((pending["id"].as_str()?, pending["session"].as_str()?));
    }
    value
        .get("action")
        .and_then(|action| marker(action, depth + 1))
}
