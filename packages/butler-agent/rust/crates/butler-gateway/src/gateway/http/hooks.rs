//! User command configuration and real synthetic tests; never model tools.
use super::*;
use butler_core::hooks::HookConfig;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    revision: u64,
    config: HookConfig,
}
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    super::security_settings::local_client(request.extensions().get::<Client>())?;
    let port = state
        .application
        .hooks()
        .ok_or_else(|| HttpError::public(404, "not_found", "Hooks unavailable"))?;
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let data = match (method, path.as_str()) {
        (Method::GET, "/hooks") => {
            port.reload().await.map_err(|e| failure(&e))?;
            serde_json::to_value(port.settings()).map_err(|_| HttpError::invalid_json())?
        }
        (Method::PUT, "/hooks") => {
            let bytes = read_body_with_limit(request.into_body(), 256 * 1024).await?;
            let input: Save =
                serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            serde_json::to_value(
                port.save(input.revision, input.config)
                    .await
                    .map_err(|e| failure(&e))?,
            )
            .map_err(|_| HttpError::invalid_json())?
        }
        (Method::GET, "/hooks/runs") => {
            serde_json::to_value(port.runs()).map_err(|_| HttpError::invalid_json())?
        }
        (Method::POST, path) if path.starts_with("/hooks/") && path.ends_with("/test") => {
            let id = path
                .strip_prefix("/hooks/")
                .and_then(|s| s.strip_suffix("/test"))
                .unwrap_or_default();
            serde_json::to_value(
                port.test(id.into(), state.shutdown.child_token())
                    .await
                    .map_err(|e| failure(&e))?,
            )
            .map_err(|_| HttpError::invalid_json())?
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
fn failure(error: &str) -> HttpError {
    let (status, code) = if error == "revision_conflict" {
        (409, "hook_revision_conflict")
    } else {
        (400, "hook_invalid")
    };
    HttpError::public(status, code, error)
}
