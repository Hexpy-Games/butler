//! Unlock the remote model account for this service process.
use super::*;
use axum::response::IntoResponse;
use butler_models::models::sealed::{self, SealedError};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Unlock {
    identity: String,
}

pub(super) async fn unlock(request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: Unlock = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    tokio::task::spawn_blocking(move || sealed::unlock(&input.identity))
        .await
        .map_err(|_| HttpError::Internal)?
        .map_err(|error| match error {
            SealedError::InvalidIdentity => HttpError::invalid_json(),
            SealedError::KeyMismatch => HttpError::public(403, error.code(), &error.to_string()),
            _ => HttpError::Internal,
        })?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
