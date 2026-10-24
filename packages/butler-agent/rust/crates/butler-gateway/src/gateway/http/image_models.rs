//! Image settings, usage and raw alpha masks use normal authenticated dispatch.
use super::*;
use crate::gateway::{
    AppAssetCommand, AppImageUsageCommand, AppModelCatalogCommand, GeneratedAssetKind,
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let uri = request.uri().clone();
    let data = match (request.method(), uri.path()) {
        (&Method::GET, "/settings/image-model") => {
            state
                .application
                .model_catalog(
                    AppModelCatalogCommand::ReadImageModel,
                    state.shutdown.child_token(),
                )
                .await?
        }
        (&Method::PUT, "/settings/image-model") => {
            let bytes = read_body_with_limit(request.into_body(), 64 * 1024).await?;
            let input = serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())?;
            state
                .application
                .model_catalog(
                    AppModelCatalogCommand::SetImageModel(input),
                    state.shutdown.child_token(),
                )
                .await?
        }
        (&Method::GET, "/usage/images") => {
            let days = params::query(&uri)
                .get("days")
                .and_then(|v| v.parse().ok())
                .filter(|d| matches!(d, 7 | 30))
                .ok_or_else(|| {
                    HttpError::public(400, "image_usage_days_invalid", "Invalid range.")
                })?;
            state
                .application
                .image_usage(AppImageUsageCommand::Stats { days })
                .await?
        }
        (&Method::POST, "/message-assets/masks") => store_mask(&state, request).await?,
        _ => {
            return Err(HttpError::public(
                405,
                "method_not_allowed",
                "Method not allowed.",
            ));
        }
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

async fn store_mask(state: &HttpState, request: Request<Body>) -> Result<Value, HttpError> {
    let uri = request.uri().clone();
    let query = params::query(&uri);
    let session = query
        .get("session")
        .cloned()
        .ok_or_else(HttpError::invalid_json)?;
    let parent_id = query
        .get("for")
        .cloned()
        .filter(|id| assets::valid_id(id))
        .ok_or_else(HttpError::invalid_json)?;
    let bytes = read_body_with_limit(request.into_body(), 50 * 1024 * 1024)
        .await?
        .to_vec();
    state
        .application
        .assets(AppAssetCommand::PutGenerated {
            session,
            bytes,
            kind: GeneratedAssetKind::Mask,
            parent_id: Some(parent_id),
            model_ref: None,
        })
        .await
        .map_err(HttpError::from)
}
