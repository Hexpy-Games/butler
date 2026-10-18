//! A page declaring a valid raster icon, served by the existing HTTP fixture.
use super::*;
pub(super) fn response(path: &str) -> Response<Body> {
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
