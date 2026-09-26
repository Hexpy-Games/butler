use std::path::{Component, Path};

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::Response,
};

use super::{HttpError, subsessions::decode_component};

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

fn mime(path: &str) -> Option<&'static str> {
    match Path::new(path).extension().and_then(|value| value.to_str()) {
        Some("html") => Some("text/html; charset=utf-8"),
        Some("css") => Some("text/css; charset=utf-8"),
        Some("js") => Some("text/javascript; charset=utf-8"),
        Some("json") => Some("application/json; charset=utf-8"),
        Some("svg") => Some("image/svg+xml"),
        _ => None,
    }
}

pub(super) fn is_public_static_request(method: &Method, path: &str) -> bool {
    *method == Method::GET && (path == "/" || mime(path).is_some())
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
    let Ok(root) = tokio::fs::canonicalize(root).await else {
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
    let candidate = root.join(&relative);
    let file = match tokio::fs::canonicalize(candidate).await {
        Ok(file) if file.starts_with(&root) && file.is_file() => file,
        _ if accepts_html || is_public_static_request(&Method::GET, pathname) => {
            let index = root.join("index.html");
            match tokio::fs::canonicalize(index).await {
                Ok(file) if file.starts_with(&root) && file.is_file() => file,
                _ => return Err(not_found()),
            }
        }
        _ => return Err(not_found()),
    };
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

fn not_found() -> HttpError {
    HttpError::public(404, "not_found", "Route not found.")
}
