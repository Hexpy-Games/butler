//! Assets share message-file capability signing and inert response headers.
use super::*;
use crate::gateway::AppAssetCommand;
use base64::{Engine, engine::general_purpose::STANDARD};
pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if request.method() != Method::GET {
        return Err(HttpError::public(
            405,
            "method_not_allowed",
            "Method not allowed.",
        ));
    }
    let id = request
        .uri()
        .path()
        .strip_prefix("/message-assets/")
        .ok_or(HttpError::Internal)?
        .to_owned();
    if !valid_id(&id) {
        return Err(HttpError::public(
            404,
            "asset_not_found",
            "Image not found.",
        ));
    }
    let query = params::query(request.uri());
    let width = query
        .get("w")
        .map(|w| {
            w.parse::<u32>()
                .ok()
                .filter(|w| (1..=1280).contains(w))
                .ok_or_else(|| HttpError::public(400, "invalid_width", "Invalid image width."))
        })
        .transpose()?;
    let result = state
        .application
        .assets(AppAssetCommand::Read {
            id: id.clone(),
            width,
        })
        .await?;
    let bytes = STANDARD
        .decode(result["data"].as_str().ok_or(HttpError::Internal)?)
        .map_err(|_| HttpError::Internal)?;
    let size = bytes.len();
    let mut response = Response::new(Body::from(bytes));
    for (name, value) in [
        (header::CONTENT_TYPE, "image/jpeg".to_owned()),
        (header::CONTENT_LENGTH, size.to_string()),
        (
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{id}.jpg\""),
        ),
        (header::CACHE_CONTROL, "no-store".to_owned()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
        (
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'".to_owned(),
        ),
    ] {
        response
            .headers_mut()
            .insert(name, value.parse().map_err(|_| HttpError::Internal)?);
    }
    Ok(response)
}
pub(super) fn valid_id(id: &str) -> bool {
    id.strip_prefix("img_").is_some_and(|s| {
        matches!(s.len(), 10 | 12)
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}
