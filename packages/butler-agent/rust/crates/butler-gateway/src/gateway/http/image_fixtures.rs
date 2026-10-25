//! Only compiled into the E2E harness agent, never into shipped binaries.
use super::*;
use crate::gateway::{AppAssetCommand, AppImageUsageCommand, GeneratedAssetKind};
use base64::{Engine, engine::general_purpose::STANDARD};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if request.method() != Method::POST {
        return Err(HttpError::public(
            405,
            "method_not_allowed",
            "Method not allowed.",
        ));
    }
    let path = request.uri().path().to_owned();
    let bytes = read_body_with_limit(request.into_body(), 70 * 1024 * 1024).await?;
    let input: Value = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
    let data = match path.rsplit('/').next() {
        Some("generated") => {
            let bytes = STANDARD
                .decode(input["data"].as_str().ok_or_else(HttpError::invalid_json)?)
                .map_err(|_| HttpError::invalid_json())?;
            let session = input["session"]
                .as_str()
                .ok_or_else(HttpError::invalid_json)?
                .to_owned();
            state
                .application
                .assets(AppAssetCommand::PutGenerated {
                    session,
                    bytes,
                    kind: GeneratedAssetKind::Generated,
                    parent_id: input["parent_id"].as_str().map(str::to_owned),
                    model_ref: input["model_ref"].as_str().map(str::to_owned),
                })
                .await?
        }
        Some("usage") => {
            let row = serde_json::from_value(input).map_err(|_| HttpError::invalid_json())?;
            state
                .application
                .image_usage(AppImageUsageCommand::Record(row))
                .await?
        }
        Some("sweep") => state.application.assets(AppAssetCommand::Sweep).await?,
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
