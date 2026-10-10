//! Existing App read routes kept together to leave the HTTP router small.

use super::*;
use axum::http::HeaderValue;
use futures_util::StreamExt;

pub(super) async fn get_messages(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let query = query(uri);
    let chat_id = query
        .get("chat_id")
        .cloned()
        .unwrap_or_else(|| "general".to_owned());
    let cursor = cursor_param(query.get("cursor"));
    state
        .application
        .refresh_message_projection(chat_id.clone())
        .await?;
    let page = state
        .application
        .list_messages(chat_id, cursor, DEFAULT_PAGE_LIMIT)
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: page,
        },
    )
}

pub(super) async fn get_artifacts(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let query = query(uri);
    let session_id = query
        .get("session_id")
        .or_else(|| query.get("sessionId"))
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| HttpError::public(400, "session_required", "Session id is required."))?;
    state
        .application
        .refresh_message_projection(session_id.clone())
        .await?;
    let artifacts = state.application.list_artifacts(session_id.clone()).await?;
    let mut artifacts = serde_json::to_value(artifacts).map_err(|_| HttpError::Internal)?;
    if let Some(items) = artifacts.as_array_mut() {
        items.extend(state.previews.artifacts(&session_id));
    }
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: serde_json::json!({ "artifacts": artifacts }),
        },
    )
}

pub(super) async fn get_session_queue(
    state: Arc<HttpState>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let query = query(uri);
    let session_id = query
        .get("session_id")
        .or_else(|| query.get("sessionId"))
        .cloned()
        .unwrap_or_else(|| "general".to_owned());
    let queue = state.application.list_session_queue(session_id).await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: queue,
        },
    )
}

pub(super) async fn get_turns(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let query = query(uri);
    let chat_id = query
        .get("chat_id")
        .cloned()
        .unwrap_or_else(|| "general".to_owned());
    let cursor = cursor_param(query.get("cursor"));
    state
        .application
        .refresh_message_projection(chat_id.clone())
        .await?;
    let turns = state.application.list_turns(chat_id, cursor).await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: turns,
        },
    )
}

pub(super) async fn get_events(state: Arc<HttpState>, uri: &Uri) -> Result<Response, HttpError> {
    let query = query(uri);
    let cursor = cursor_param(query.get("cursor"));
    let limit = limit_param(query.get("limit"));
    let events = state.application.replay_events(cursor, limit).await?;
    let next_cursor = events.last().map_or(cursor, |event| event.id as f64);
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: EventReplayView {
                events,
                next_cursor,
            },
        },
    )
}

/// `GET /events/live`: the stream closes with the listener it came through
/// and when the token it was authorized with (`keys`) rotates.
pub(super) async fn get_live_events(
    state: Arc<HttpState>,
    uri: &Uri,
    scope: Option<super::listeners::ListenerScope>,
    keys: &super::security::KeySet,
) -> Result<Response, HttpError> {
    let cursor = cursor_param(query(uri).get("cursor"));
    let mut closers = vec![keys.live_streams()];
    closers.extend(scope.map(|scope| scope.closed));
    let stream = create_live_stream(state.application.clone(), cursor, closers).await?;
    let body = match keys.live_chunk_signer() {
        Some(sign) => Body::from_stream(stream.map(move |chunk| chunk.map(&sign))),
        None => Body::from_stream(stream),
    };
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

/// `GET /health`.
pub(super) fn health() -> Result<Response, HttpError> {
    let data = HealthView {
        ok: true,
        service: "butler-app-server".to_owned(),
        protocol_version: APP_PROTOCOL_VERSION.to_owned(),
    };
    if let Some(opens) = crate::gateway::idle_probe::transcript_opens() {
        let mut probe = serde_json::to_value(data).map_err(|_| HttpError::Internal)?;
        probe["transcript_read_opens"] = serde_json::json!(opens);
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: probe,
            },
        );
    }
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
