//! Socket-only routes through which the main hands a remote Butler its memory.
use super::*;
use axum::response::IntoResponse;
use butler_turn::remote_memory::{self, MemoryCopy};

/// `POST /remote/memory`: the main's instructions and profile, replacing the previous copy.
pub(super) async fn copy(request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let copy: MemoryCopy = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    remote_memory::replace_copy(copy);
    Ok(StatusCode::NO_CONTENT.into_response())
}
