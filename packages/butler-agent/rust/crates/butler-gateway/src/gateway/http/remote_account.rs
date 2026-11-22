//! Unlock the remote model account for this service process.
use super::*;
use axum::response::IntoResponse;
use butler_models::models::sealed::{self, SealedError};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Unlock {
    identity: String,
}

/// The remote routes exist only for the main: POST over the owner-only
/// socket, with the admin credential, in remote mode. Otherwise 404. Checked
/// after admission so the access log names the route.
pub(super) fn admitted(state: &HttpState, request: &Request<Body>) -> bool {
    request.method() == Method::POST
        && request
            .extensions()
            .get::<listeners::LocalSocketPeer>()
            .is_some()
        && state.security.is_admin(request.headers())
        && sealed::is_enabled()
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
