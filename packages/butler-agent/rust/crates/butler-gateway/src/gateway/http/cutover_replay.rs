//! Authenticated local replay of a previously admitted request.
use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Replay {
    chat_id: String,
    source_message_id: String,
    receipt_id: String,
}
pub(super) async fn post(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: Replay = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    state
        .application
        .replay_kept_request(input.chat_id, input.source_message_id, input.receipt_id)
        .await?;
    json(StatusCode::ACCEPTED, serde_json::json!({"ok":true}))
}
