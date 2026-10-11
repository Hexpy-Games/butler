//! Shared HTTP body admission and bounded reads.
use super::HttpError;
use axum::{
    body::{Body, Bytes, to_bytes},
    http::{HeaderValue, Request, StatusCode, header},
    response::Response,
};
use http_body_util::LengthLimitError;
use std::error::Error as StdError;

pub(super) const MAX_REQUEST_BODY_SIZE: usize = 128 * 1024 * 1024;

pub(super) fn declared_body_too_large(request: &Request<Body>) -> bool {
    request
        .headers()
        .get_all(header::CONTENT_LENGTH)
        .iter()
        .filter_map(|value| value.to_str().ok()?.parse::<u128>().ok())
        .any(|length| length > MAX_REQUEST_BODY_SIZE as u128)
}

pub(super) fn payload_too_large_response() -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::PAYLOAD_TOO_LARGE;
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

pub(in crate::gateway) async fn read_body_with_limit(
    body: Body,
    limit: usize,
) -> Result<Bytes, HttpError> {
    to_bytes(body, limit)
        .await
        .map_err(classify_body_read_error)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn classify_body_read_error(error: axum::Error) -> HttpError {
    let mut source: &(dyn StdError + 'static) = &error;
    loop {
        if source.is::<LengthLimitError>() {
            return HttpError::PayloadTooLarge;
        }
        let Some(next) = source.source() else {
            return HttpError::invalid_json();
        };
        source = next;
    }
}
