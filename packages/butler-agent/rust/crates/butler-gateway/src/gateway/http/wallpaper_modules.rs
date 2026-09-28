//! Wallpaper modules over HTTP:
//!
//! - `GET /wallpaper-modules` → `{modules: [{...manifest, source, status}]}`
//! - `GET /wallpaper-modules/{id}/shader` → a valid user module's GLSL as
//!   `text/plain`, `ETag` = the revision of its files
//! - `GET /wallpaper-modules/{id}/overlay` → its `overlay.frag` the same way
//!   (404 `wallpaper_module_file_not_found` without `"overlay": true`)
//! - `GET /wallpaper-modules/{id}/image` → its `defaultImage` bytes as
//!   `image/jpeg`, `image/png` or `image/webp`, same `ETag` (404 without one)
//! - `POST /wallpaper-modules/{id}/status` `{state: "checking" | "ok" |
//!   "error", message?, revision?}` → `{id, status}`; the App marks a revision
//!   `checking` before it compiles and first draws it, then reports compile,
//!   link and frame budget results; `revision` is the shader's `ETag` it
//!   checked
//! - `POST /wallpaper-modules/import[?replace=1]` multipart `file` (zip, at
//!   most 2 MB) → 201 module entry; 409 `wallpaper_module_exists` when the id
//!   is installed and `replace` is not set
//! - `DELETE /wallpaper-modules/{id}` → `{id, deleted: true}`, 409
//!   `wallpaper_module_in_use` while the setting or a project draws with it
//! - `POST /internal/wallpaper-modules` `{id, manifest, shader, overlay?,
//!   replace_revision?}` → 200 `{id, status}` once the App checked the
//!   written files (or `unknown` after a short wait), for the agent's
//!   `save_wallpaper_module`; a module rule the request breaks is a 400
//!   `{error: {code, message, field}}`, and replacing an installed module
//!   without its current revision a 409 `wallpaper_module_exists`

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use serde_json::json;

use super::{
    HttpError, HttpState, MAX_REQUEST_BODY_SIZE, read_body_with_limit,
    wallpapers::{envelope, read_upload, rejected, route_not_found},
};
use crate::gateway::{
    AppWallpaperModuleShader, AppWallpaperModuleStatusReport, wallpaper_modules::import,
    wallpapers::AppWallpaperModuleSaveRequest,
};

const ROOT: &str = "/wallpaper-modules";
const SAVE_PATH: &str = "/internal/wallpaper-modules";
// One byte past the archive limit, so the owner reports the size error.
const ARCHIVE_RETAIN_BYTES: usize = import::MAX_ARCHIVE_BYTES + 1;

pub(super) fn handles(path: &str) -> bool {
    path == ROOT || path == SAVE_PATH || path.starts_with("/wallpaper-modules/")
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if path == SAVE_PATH {
        return match method {
            Method::POST => save(&state, request).await,
            _ => Err(route_not_found()),
        };
    }
    let segments: Vec<&str> = path
        .strip_prefix(ROOT)
        .unwrap_or_default()
        .split('/')
        .skip(1)
        .collect();
    let application = &state.application;
    match (method, segments.as_slice()) {
        (Method::GET, []) => {
            let modules = application.wallpaper_modules().await?;
            envelope(StatusCode::OK, json!({ "modules": modules }))
        }
        (Method::POST, ["import"]) => {
            let replace = request
                .uri()
                .query()
                .is_some_and(|query| query.split('&').any(|pair| pair == "replace=1"));
            let _upload = state
                .uploads
                .acquire()
                .await
                .map_err(|_| HttpError::Internal)?;
            let archive = read_upload(request, ARCHIVE_RETAIN_BYTES).await?;
            let module = application
                .import_wallpaper_module(archive, replace)
                .await?;
            envelope(StatusCode::CREATED, module)
        }
        (Method::GET, [id, "shader"]) => text(
            application
                .wallpaper_module_shader((*id).to_owned())
                .await?,
        ),
        (Method::GET, [id, "overlay"]) => text(
            application
                .wallpaper_module_overlay((*id).to_owned())
                .await?,
        ),
        (Method::GET, [id, "image"]) => {
            let image = application.wallpaper_module_image((*id).to_owned()).await?;
            let length = image.bytes.len();
            file(image.bytes.into(), length, &image.mime_type, &image.etag)
        }
        (Method::POST, [id, "status"]) => {
            let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
            let report: AppWallpaperModuleStatusReport =
                serde_json::from_slice(&bytes).map_err(|_| {
                    HttpError::public(
                        400,
                        "wallpaper_module_status_invalid",
                        "Status must be {state: \"checking\" | \"ok\" | \"error\", message?, \
                         revision?}.",
                    )
                })?;
            let status = application
                .report_wallpaper_module_status((*id).to_owned(), report)
                .await?;
            envelope(StatusCode::OK, json!({ "id": id, "status": status }))
        }
        (Method::DELETE, [id]) => {
            application
                .delete_wallpaper_module((*id).to_owned())
                .await?;
            envelope(StatusCode::OK, json!({ "id": id, "deleted": true }))
        }
        _ => Err(route_not_found()),
    }
}

async fn save(state: &HttpState, request: Request<Body>) -> Result<Response, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    let input: AppWallpaperModuleSaveRequest = serde_json::from_slice(&bytes).map_err(|_| {
        HttpError::public(
            400,
            "wallpaper_module_request_invalid",
            "Module save must be {id: string, manifest: object, shader: string, overlay?: \
             string, replace_revision?: string}.",
        )
    })?;
    match state.application.save_wallpaper_module(input).await? {
        Ok(saved) => envelope(StatusCode::OK, saved),
        Err(rejection) => rejected(&rejection),
    }
}

/// A shader text, never cached: the files change while an author works.
fn text(shader: AppWallpaperModuleShader) -> Result<Response, HttpError> {
    let length = shader.text.len();
    let etag = format!("\"{}\"", shader.revision);
    file(
        shader.text.into(),
        length,
        "text/plain; charset=utf-8",
        &etag,
    )
}

/// A module file, never cached, tagged with the module's revision.
fn file(body: Body, length: usize, mime_type: &str, etag: &str) -> Result<Response, HttpError> {
    let size = length.to_string();
    let mut response = Response::new(body);
    for (name, value) in [
        (header::CONTENT_TYPE, mime_type),
        (header::CONTENT_LENGTH, size.as_str()),
        (header::CACHE_CONTROL, "no-store"),
        (header::ETAG, etag),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
    ] {
        response
            .headers_mut()
            .insert(name, value.parse().map_err(|_| HttpError::Internal)?);
    }
    Ok(response)
}
