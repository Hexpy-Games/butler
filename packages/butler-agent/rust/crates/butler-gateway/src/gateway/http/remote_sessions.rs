//! One rule for conversations that run on a registered computer: forward, refuse, or serve here.
use super::{
    Body, HttpError, HttpState, MAX_REQUEST_BODY_SIZE, Method, Request, Response, StatusCode, Uri,
    content, json, query, read_body_with_limit, router::Handler,
};
use crate::gateway::remote_computers::{self, RemoteStream};
use axum::{
    body::Bytes,
    http::{HeaderMap, HeaderValue, header, request::Parts},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

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
        relays: Some(state.remote_live.clone()),
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
    if let Some(response) = remote_view(state, handler, &parts, &computer).await? {
        return Ok(Routed::Answered(response));
    }
    let path = parts
        .uri
        .path_and_query()
        .map_or(parts.uri.path(), |p| p.as_str());
    let remote = link(state)?;
    if parts.method == Method::GET && streamed(handler) {
        let stream = remote_computers::open_stream(&remote, &computer, path).await?;
        return Ok(Routed::Answered(streamed_response(stream)?));
    }
    let reply = remote_computers::forward(
        &remote,
        &computer,
        parts.method.as_str(),
        path,
        bytes.to_vec(),
    )
    .await?;
    if (200..300).contains(&reply.status)
        && (parts.method != Method::GET || remote_computers::names_running_turn(&reply.body))
    {
        state
            .remote_live
            .ensure(remote, state.application.clone(), &computer);
    }
    Ok(Routed::Answered(forwarded_response(reply)?))
}

async fn remote_view(
    state: &HttpState,
    handler: Handler,
    parts: &Parts,
    computer: &str,
) -> Result<Option<Response>, HttpError> {
    if !parts.uri.path().ends_with("/view") {
        return Ok(None);
    }
    match handler {
        Handler::Output => content::remote::output_view(
            state,
            parts.headers.clone(),
            parts.uri.clone(),
            computer.to_owned(),
        )
        .await
        .map(Some),
        Handler::MessageFiles => {
            content::remote::message_file_view(state, &parts.headers, &parts.uri, computer)
                .map(Some)
        }
        _ => Ok(None),
    }
}

fn forwarded_response(reply: remote_computers::Reply) -> Result<Response, HttpError> {
    let status = StatusCode::from_u16(reply.status).map_err(|_| HttpError::Internal)?;
    let Some(bytes) = reply.bytes else {
        return json(status, reply.body);
    };
    let bytes = STANDARD.decode(bytes).map_err(|_| HttpError::Internal)?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    content_headers(response.headers_mut(), &reply.headers);
    Ok(response)
}

fn streamed_response(stream: RemoteStream) -> Result<Response, HttpError> {
    if stream.status == 401 {
        return Err(HttpError::public(
            422,
            "remote_request_failed",
            "The computer refused the request.",
        ));
    }
    let status = StatusCode::from_u16(stream.status).map_err(|_| HttpError::Internal)?;
    let headers = stream.headers.clone();
    let mut response = Response::new(stream.into_body());
    *response.status_mut() = status;
    content_headers(response.headers_mut(), &headers);
    Ok(response)
}

fn content_headers(headers: &mut HeaderMap, remote: &BTreeMap<String, String>) {
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_DISPOSITION,
        header::CACHE_CONTROL,
    ] {
        if let Some(value) = remote
            .get(name.as_str())
            .and_then(|v| HeaderValue::from_str(v).ok())
        {
            headers.insert(name, value);
        }
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/pdf"))
    {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("sandbox; default-src 'none'"),
        );
    }
}

fn streamed(handler: Handler) -> bool {
    matches!(handler, Handler::MessageFiles | Handler::TranscriptExport)
}

fn forwarded(handler: Handler) -> bool {
    matches!(
        handler,
        Handler::MessageFiles
            | Handler::Output
            | Handler::Messages
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
