use std::path::{Component, Path, PathBuf};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
};

use super::{HttpError, subsessions::decode_component};
use butler_platform::secure_fs;

/// `font-src data:`: a scrap's HTML copy opens in a sandboxed `srcdoc` frame,
/// which inherits this policy, and carries its web fonts as data: URLs.
pub(super) const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

fn mime(path: &str) -> Option<&'static str> {
    match Path::new(path).extension().and_then(|value| value.to_str()) {
        Some("html") => Some("text/html; charset=utf-8"),
        Some("css") => Some("text/css; charset=utf-8"),
        Some("js") => Some("text/javascript; charset=utf-8"),
        Some("gz") => Some("application/gzip"),
        Some("json") => Some("application/json; charset=utf-8"),
        Some("svg") => Some("image/svg+xml"),
        // Bundled UI fonts: @font-face requests carry no Authorization header.
        Some("woff2") => Some("font/woff2"),
        _ => None,
    }
}

/// Scripts, styles, images and data files of the UI bundle (`/assets/..` or
/// a root file) are public; its HTML documents are served only to an
/// authenticated browser. API paths, which all have two or more segments
/// outside `/assets/`, never become public by ending in an extension.
pub(super) fn is_public_asset(method: &Method, path: &str) -> bool {
    let bundle_path = path
        .strip_prefix('/')
        .is_some_and(|rest| rest.starts_with("assets/") || !rest.contains('/'));
    *method == Method::GET
        && bundle_path
        && mime(path).is_some_and(|mime| !mime.starts_with("text/html"))
}

fn is_static_path(path: &str) -> bool {
    path == "/" || mime(path).is_some()
}

pub(super) fn accepts_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/html"))
}

pub(super) async fn serve(
    root: Option<&Path>,
    pathname: &str,
    accepts_html: bool,
) -> Result<Response, HttpError> {
    // API clients receive JSON 404s. Browser navigation and static assets use
    // the installed UI, after the named API routes have had their chance.
    if pathname != "/"
        && mime(pathname).is_none()
        && !pathname.starts_with("/assets/")
        && !accepts_html
    {
        return Err(not_found());
    }
    let Some(root) = root else {
        return Err(not_found());
    };
    let relative = if pathname == "/" {
        "index.html".to_owned()
    } else {
        decode_component(pathname.trim_start_matches('/'))?
    };
    if Path::new(&relative)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(not_found());
    }
    let fallback = accepts_html || is_static_path(pathname);
    let (root, name) = (root.to_path_buf(), relative.clone());
    let file = tokio::task::spawn_blocking(move || resolve(&root, &name, fallback))
        .await
        .ok()
        .flatten()
        .ok_or_else(not_found)?;
    let content_type = if file.file_name().is_some_and(|value| value == "index.html") {
        "text/html; charset=utf-8"
    } else {
        mime(&relative).unwrap_or("application/octet-stream")
    };
    let bytes = tokio::fs::read(file)
        .await
        .map_err(|_| HttpError::Internal)?;
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::OK;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

/// The file `relative` names inside `root`, or `root`'s `index.html` when
/// `fallback`: resolved, and only when it stays inside `root`.
fn resolve(root: &Path, relative: &str, fallback: bool) -> Option<PathBuf> {
    let root = secure_fs::canonicalize(root).ok()?;
    let inside = |path: PathBuf| {
        secure_fs::canonicalize(path)
            .ok()
            .filter(|file| secure_fs::is_within(file, &root) && file.is_file())
    };
    inside(root.join(relative)).or_else(|| fallback.then(|| inside(root.join("index.html")))?)
}

fn not_found() -> HttpError {
    HttpError::public(404, "not_found", "Route not found.")
}
