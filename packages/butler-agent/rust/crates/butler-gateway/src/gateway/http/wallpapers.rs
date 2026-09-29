//! Wallpaper assets over HTTP:
//!
//! - `POST /wallpapers` multipart `file` → 201 asset
//! - `GET /wallpapers` → `{wallpapers: [asset]}`, newest first
//! - `GET /wallpapers/{id}` and `GET /wallpapers/{id}/thumbnail` → image bytes
//! - `DELETE /wallpapers/{id}` → `{id, deleted: true}`, 409 while referenced
//! - `POST /internal/wallpapers/from-message-file` `{file_id}` → 201 asset,
//!   for agent tools that turn an attachment into a wallpaper.
//! - `GET /internal/wallpaper?project_id=` → the agent's overview: global
//!   setting, project wallpaper, modules with their status, the user module
//!   directory and images
//! - `POST /internal/wallpaper` `{scope, project_id?, source}` → 200
//!   `{scope, projectId?, previous, next, changed}`; a correctable request is
//!   a 4xx `{error: {code, message, field, allowed?}}`.
//!
//! The `/internal/*` routes are for the local agent. They need the same
//! bearer token as every other route, so any holder of that token can write
//! a wallpaper whose `wallpaper.changed` says `origin: "agent"`; the origin
//! labels the route, it is not an authentication of the caller.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequest, Multipart},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use bytes::{Bytes, BytesMut};
use serde::Deserialize;
use serde_json::json;

use super::{
    HttpError, HttpState, MAX_REQUEST_BODY_SIZE,
    error::json,
    message_files::{file_required, invalid_multipart, multipart_error},
    read_body_with_limit,
};
use crate::gateway::{
    AppWallpaperRejection, AppWallpaperSetRequest, AppWallpaperVariant,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

const PROMOTE_PATH: &str = "/internal/wallpapers/from-message-file";
const AGENT_PATH: &str = "/internal/wallpaper";
// One byte past the 25 MiB limit, so the owner reports the size error.
const UPLOAD_RETAIN_BYTES: usize = 25 * 1024 * 1024 + 1;
const IMMUTABLE: &str = "private, max-age=31536000, immutable";

/// Asset and agent routes, and the module routes of [`super::wallpaper_modules`].
pub(super) fn handles(path: &str) -> bool {
    path == "/wallpapers"
        || path.starts_with("/wallpapers/")
        || [PROMOTE_PATH, AGENT_PATH].contains(&path)
        || super::wallpaper_modules::handles(path)
}

#[derive(Deserialize)]
struct PromoteRequest {
    file_id: String,
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if super::wallpaper_modules::handles(&path) {
        return super::wallpaper_modules::route(state, request).await;
    }
    match (&method, path.as_str()) {
        (&Method::GET, AGENT_PATH) => {
            let project_id = super::query(request.uri()).remove("project_id");
            let overview = state.application.wallpaper_overview(project_id).await?;
            return envelope(StatusCode::OK, overview);
        }
        (&Method::POST, AGENT_PATH) => return set(&state, request).await,
        (_, AGENT_PATH) => return Err(route_not_found()),
        _ => {}
    }
    if path == PROMOTE_PATH {
        if method != Method::POST {
            return Err(route_not_found());
        }
        let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        let input: PromoteRequest =
            serde_json::from_slice(&bytes).map_err(|_| invalid_promotion())?;
        let asset = state
            .application
            .promote_message_file_to_wallpaper(input.file_id)
            .await?;
        return envelope(StatusCode::CREATED, asset);
    }
    let segments: Vec<&str> = path
        .strip_prefix("/wallpapers")
        .unwrap_or_default()
        .split('/')
        .skip(1)
        .collect();
    match (method, segments.as_slice()) {
        (Method::POST, []) => {
            let _upload = state
                .uploads
                .acquire()
                .await
                .map_err(|_| HttpError::Internal)?;
            let source = read_upload(request, UPLOAD_RETAIN_BYTES).await?;
            let asset = state.application.upload_wallpaper(source).await?;
            envelope(StatusCode::CREATED, asset)
        }
        (Method::GET, []) => {
            let wallpapers = state.application.list_wallpapers().await?;
            envelope(StatusCode::OK, json!({ "wallpapers": wallpapers }))
        }
        (Method::GET, [id]) => file(&state, id, AppWallpaperVariant::Image).await,
        (Method::GET, [id, "thumbnail"]) => file(&state, id, AppWallpaperVariant::Thumbnail).await,
        (Method::DELETE, [id]) => {
            let deleted = state.application.delete_wallpaper((*id).to_owned()).await?;
            envelope(StatusCode::OK, json!({ "id": deleted.id, "deleted": true }))
        }
        _ => Err(route_not_found()),
    }
}

async fn set(state: &HttpState, request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: AppWallpaperSetRequest = serde_json::from_slice(&bytes).map_err(|_| {
        HttpError::public(
            400,
            "wallpaper_request_invalid",
            "Wallpaper request must be {scope: \"global\" | \"project\", project_id?, source}.",
        )
    })?;
    match state.application.set_wallpaper(input).await? {
        Ok(change) => envelope(StatusCode::OK, change),
        Err(rejection) => rejected(&rejection),
    }
}

/// The API error envelope with the rejection's field and allowed values.
pub(super) fn rejected(rejection: &AppWallpaperRejection) -> Result<Response, HttpError> {
    #[derive(serde::Serialize)]
    struct Rejected<'a> {
        protocol_version: &'static str,
        error: &'a AppWallpaperRejection,
    }
    let status = StatusCode::from_u16(rejection.status).unwrap_or(StatusCode::BAD_REQUEST);
    json(
        status,
        Rejected {
            protocol_version: APP_PROTOCOL_VERSION,
            error: rejection,
        },
    )
}

async fn file(
    state: &HttpState,
    id: &str,
    variant: AppWallpaperVariant,
) -> Result<Response, HttpError> {
    let file = state
        .application
        .read_wallpaper(id.to_owned(), variant)
        .await?;
    let size = file.bytes.len();
    let mut response = Response::new(Body::from(file.bytes));
    for (name, value) in [
        (header::CONTENT_TYPE, file.mime_type),
        (header::CONTENT_LENGTH, size.to_string()),
        (header::CACHE_CONTROL, IMMUTABLE.to_owned()),
        (header::ETAG, file.etag),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
    ] {
        response
            .headers_mut()
            .insert(name, value.parse().map_err(|_| HttpError::Internal)?);
    }
    Ok(response)
}

/// The first `file` field, of which at most `retain` bytes are kept (one past
/// the owner's limit, so the owner reports the size error); other fields are
/// drained and ignored.
pub(super) async fn read_upload(request: Request<Body>, retain: usize) -> Result<Bytes, HttpError> {
    let mut form = Multipart::from_request(request, &())
        .await
        .map_err(|_| invalid_multipart())?;
    let mut file = None;
    while let Some(mut field) = form.next_field().await.map_err(multipart_error)? {
        if field.name() == Some("file") && file.is_none() {
            let mut bytes = BytesMut::new();
            while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                let keep = chunk.len().min(retain - bytes.len());
                bytes.extend_from_slice(&chunk[..keep]);
            }
            file = Some(bytes.freeze());
        } else {
            while field.chunk().await.map_err(multipart_error)?.is_some() {}
        }
    }
    file.ok_or_else(file_required)
}

pub(super) fn envelope<T: serde::Serialize>(
    status: StatusCode,
    data: T,
) -> Result<Response, HttpError> {
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

fn invalid_promotion() -> HttpError {
    HttpError::public(
        400,
        "wallpaper_promotion_invalid",
        "Promotion request must name a message file_id.",
    )
}

pub(super) fn route_not_found() -> HttpError {
    HttpError::public(404, "not_found", "Route not found.")
}
