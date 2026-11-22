//! Socket-only routes through which the main hands a remote Butler its memory
//! and answers the reads it waits on.
use super::*;
use crate::gateway::{AppEventEnvelope, EventSubscription, PublishedEvent, live::LiveListener};
use axum::response::IntoResponse;
use butler_turn::remote_instructions;
use butler_turn::remote_memory::{self, MemoryCopy};

/// `POST /remote/memory`: the main's instructions and profile, replacing the previous copy.
pub(super) async fn copy(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let copy: MemoryCopy = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let data = state.output_data.as_deref().ok_or(HttpError::Internal)?;
    let ids = copy.pending_ids.clone();
    remote_memory::replace_copy(copy);
    remote_instructions::settle(data, &ids)
        .await
        .map_err(|_| HttpError::Internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /remote/memory/answers`: the main's answer to a waiting memory read.
pub(super) async fn answer(request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let answer: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let id = answer["read_id"]
        .as_str()
        .ok_or_else(HttpError::invalid_json)?
        .to_owned();
    if !remote_memory::answer(&id, answer) {
        return Err(HttpError::public(
            404,
            "memory_read_not_found",
            "The memory read is no longer waiting.",
        ));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub(super) async fn pending(
    state: Arc<HttpState>,
    _request: Request<Body>,
) -> Result<Response, HttpError> {
    let data = state.output_data.as_deref().ok_or(HttpError::Internal)?;
    Ok(
        axum::Json(serde_json::json!({"items":remote_instructions::take(data).await}))
            .into_response(),
    )
}

pub(super) async fn ack(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    #[derive(serde::Deserialize)]
    struct Ack {
        ids: Vec<String>,
    }
    let data = state.output_data.as_deref().ok_or(HttpError::Internal)?;
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: Ack = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    remote_instructions::ack(data, &input.ids)
        .await
        .map_err(|_| HttpError::Internal)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Reads waiting for the main, as id-less frames of the main's live stream.
pub(super) fn watch(listener: LiveListener) -> Box<dyn EventSubscription> {
    let attachment = remote_memory::attach_main(Arc::new(
        move |event_type, request: &serde_json::Value| {
            listener(Arc::new(PublishedEvent::new(AppEventEnvelope {
                id: 0,
                event_type: event_type.to_owned(),
                protocol_version: APP_PROTOCOL_VERSION.to_owned(),
                created_at: butler_core::js_date::iso_from_system_time(std::time::SystemTime::now()),
                payload: request.as_object().cloned().unwrap_or_default(),
            })));
        },
    ));
    Box::new(Watch {
        _attachment: attachment,
    })
}

struct Watch {
    _attachment: remote_memory::MainAttachment,
}

impl EventSubscription for Watch {}
