//! A page declaring a valid raster icon, served by the existing HTTP fixture.
//! Like many sites, it refuses clients that call themselves bots.
use super::*;
pub(super) fn response(path: &str, headers: &HeaderMap) -> Response<Body> {
    let user_agent = headers.get("user-agent").and_then(|v| v.to_str().ok());
    if user_agent.is_some_and(|ua| ua.to_ascii_lowercase().contains("bot")) {
        let mut refused = Response::new(Body::empty());
        *refused.status_mut() = StatusCode::FORBIDDEN;
        return refused;
    }
    let (mime, bytes) = if path == "/favicon.ico" {
        ("image/png", crate::e2e::media::digits_png("42", 12))
    } else {
        (
            "text/html",
            b"<html><head><link rel=\"icon\" href=\"/favicon.ico\"></head></html>".to_vec(),
        )
    };
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert("content-type", axum::http::HeaderValue::from_static(mime));
    response
}
