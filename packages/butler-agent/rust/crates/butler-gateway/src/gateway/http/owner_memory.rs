//! Owner memory control routes share the gateway authentication boundary.
use super::{HttpError, HttpState};
use axum::{body::Body, http::Uri, response::Response};
use std::sync::Arc;
pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    if uri.path().starts_with("/memory/feedback") {
        super::feedback::route(state, request, uri).await
    } else {
        super::personalization::route(state, request, uri).await
    }
}
