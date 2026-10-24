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
    let suffix = request
        .uri()
        .path()
        .strip_prefix("/message-assets/")
        .ok_or(HttpError::Internal)?
        .to_owned();
    let (id, operation) = suffix.split_once('/').unwrap_or((&suffix, ""));
    let id = id.to_owned();
    if !valid_id(&id) {
        return Err(HttpError::public(
            404,
            "asset_not_found",
            "Image not found.",
        ));
    }
    if matches!(operation, "meta" | "versions") {
        let command = if operation == "meta" {
            AppAssetCommand::Meta { id }
        } else {
            AppAssetCommand::Versions { id }
        };
        let data = state.application.assets(command).await?;
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        );
    }
    if !operation.is_empty() {
        return Err(HttpError::public(
            404,
            "asset_not_found",
            "Image not found.",
        ));
    }
    let query = params::query(request.uri());
    let download = query.get("download").is_some_and(|v| v == "1");
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
            width: if download { None } else { width },
        })
        .await?;
    image_response(&id, &result, download)
}

fn image_response(id: &str, result: &Value, download: bool) -> Result<Response, HttpError> {
    let bytes = STANDARD
        .decode(result["data"].as_str().ok_or(HttpError::Internal)?)
        .map_err(|_| HttpError::Internal)?;
    let mime = result["mime"].as_str().ok_or(HttpError::Internal)?;
    let ext = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    };
    let disposition = if download { "attachment" } else { "inline" };
    let size = bytes.len();
    let mut response = Response::new(Body::from(bytes));
    for (name, value) in [
        (header::CONTENT_TYPE, mime.to_owned()),
        (header::CONTENT_LENGTH, size.to_string()),
        (
            header::CONTENT_DISPOSITION,
            format!("{disposition}; filename=\"{id}.{ext}\""),
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
