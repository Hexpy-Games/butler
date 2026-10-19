//! Local desktop admin only, with a strict small-body wire contract.
use super::*;
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    super::security_settings::local_client(request.extensions().get::<Client>())?;
    let port = state.application.data_reset().ok_or_else(|| {
        HttpError::public(503, "full_reset_unavailable", "Full reset unavailable.")
    })?;
    let (status, data) = match *request.method() {
        Method::GET => (
            StatusCode::OK,
            serde_json::to_value(port.nonce()?).map_err(|_| invalid())?,
        ),
        Method::POST => {
            let bytes = read_body_with_limit(request.into_body(), 4096)
                .await
                .map_err(|_| invalid())?;
            let input = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            let app = state.application.clone();
            // The task owns acceptance even after the HTTP client disconnects.
            let data = tokio::spawn(async move { app.accept_full_reset(input).await })
                .await
                .map_err(|_| HttpError::public(500, "full_reset_failed", "Full reset failed."))??;
            (StatusCode::ACCEPTED, data)
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
fn invalid() -> HttpError {
    HttpError::public(
        400,
        "full_reset_confirmation_invalid",
        "Reset confirmation is invalid.",
    )
}
