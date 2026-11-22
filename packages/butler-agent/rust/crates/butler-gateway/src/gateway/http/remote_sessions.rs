//! One rule for conversations that run on a registered computer: forward, refuse, or serve here.
use super::{
    Body, HttpError, HttpState, MAX_REQUEST_BODY_SIZE, Method, Request, Response, StatusCode, Uri,
    json, query, read_body_with_limit, router::Handler,
};
use crate::gateway::remote_computers;
use axum::body::Bytes;
use serde_json::Value;
use std::sync::Arc;

pub(super) enum Routed {
    Here(Request<Body>),
    Answered(Response),
}

pub(super) fn link(state: &HttpState) -> Result<remote_computers::Link, HttpError> {
    Ok(remote_computers::Link {
        setup: state.application.setup()?,
        root: state.output_data.clone().ok_or(HttpError::Internal)?,
        version: state.agent_version.clone(),
        cancel: state.shutdown.clone(),
    })
}

pub(super) async fn route(
    state: &Arc<HttpState>,
    handler: Handler,
    request: Request<Body>,
) -> Result<Routed, HttpError> {
    if !forwarded(handler) && !refused(handler) {
        return Ok(Routed::Here(request));
    }
    let id = named_session(request.uri())?;
    let (parts, body) = request.into_parts();
    let bytes = if matches!(parts.method, Method::POST | Method::PATCH | Method::DELETE) {
        read_body_with_limit(body, MAX_REQUEST_BODY_SIZE).await?
    } else {
        Bytes::new()
    };
    let Some(id) = id.or_else(|| body_session(handler, &parts.method, &bytes)) else {
        return Ok(Routed::Here(Request::from_parts(parts, Body::from(bytes))));
    };
    let Some(computer) = state.application.session_computer(id).await? else {
        return Ok(Routed::Here(Request::from_parts(parts, Body::from(bytes))));
    };
    if refused(handler) {
        return Err(HttpError::public(
            409,
            "remote_session_unsupported",
            "This conversation runs on another computer.",
        ));
    }
    if !matches!(
        parts.method,
        Method::GET | Method::POST | Method::PATCH | Method::DELETE
    ) {
        return Ok(Routed::Here(Request::from_parts(parts, Body::from(bytes))));
    }
    if bytes.len() > 1024 * 1024 {
        return Err(HttpError::PayloadTooLarge);
    }
    let reply = remote_computers::forward(
        &link(state)?,
        &computer,
        parts.method.as_str(),
        parts
            .uri
            .path_and_query()
            .map_or(parts.uri.path(), |p| p.as_str()),
        bytes.to_vec(),
    )
    .await?;
    Ok(Routed::Answered(json(
        StatusCode::from_u16(reply.status).map_err(|_| HttpError::Internal)?,
        reply.body,
    )?))
}

fn forwarded(handler: Handler) -> bool {
    matches!(
        handler,
        Handler::Messages
            | Handler::Turns
            | Handler::Artifacts
            | Handler::SessionQueue
            | Handler::Queue
            | Handler::Controls
            | Handler::PendingAsks
            | Handler::Authority
            | Handler::Models
            | Handler::Cancel
            | Handler::Retry
            | Handler::Operation
            | Handler::Subsessions
            | Handler::TranscriptExport
            | Handler::TaskGraphs
            | Handler::Monitors
    )
}

fn refused(handler: Handler) -> bool {
    matches!(handler, Handler::Canon | Handler::Automations)
}

fn named_session(uri: &Uri) -> Result<Option<String>, HttpError> {
    if let Some(encoded) = uri
        .path()
        .strip_prefix("/sessions/")
        .and_then(|path| path.split('/').next())
    {
        let id = super::authority::decode_component(encoded)?;
        if !id.is_empty() {
            return Ok(Some(id));
        }
    }
    let params = query(uri);
    Ok(["session_id", "sessionId", "chat_id"]
        .iter()
        .find_map(|key| params.get(*key).filter(|id| !id.trim().is_empty()).cloned()))
}

fn body_session(handler: Handler, method: &Method, bytes: &[u8]) -> Option<String> {
    let field = match (handler, method) {
        (Handler::Messages | Handler::SessionQueue, &Method::POST) => "chat_id",
        (Handler::Automations, &Method::POST | &Method::PATCH) => "target_session_id",
        (Handler::Subsessions, &Method::POST) => "parent_session_id",
        _ => return None,
    };
    let body: Value = serde_json::from_slice(bytes).ok()?;
    body.get(field)?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}
