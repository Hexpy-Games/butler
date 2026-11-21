//! Local admin routes for the Butler account.
use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    response::Response,
};

use super::{
    Client, HttpError, security_settings,
    setup::{body, envelope, not_found},
    subsessions::decode_component,
};
use crate::gateway::{AppSetupPort, ButlerAccountRequest};

pub(super) async fn route(
    setup: &Arc<dyn AppSetupPort>,
    request: Request<Body>,
    path: &str,
) -> Result<Response, HttpError> {
    security_settings::local_client(request.extensions().get::<Client>())?;
    let operation = match (request.method(), path) {
        (&Method::GET, "/setup/butler-account") => ButlerAccountRequest::Status,
        (&Method::POST, "/setup/butler-account") => body(request).await?,
        (&Method::DELETE, "/setup/butler-account") => ButlerAccountRequest::SignOut,
        (&Method::GET, "/setup/butler-account/devices") => ButlerAccountRequest::Devices,
        (&Method::DELETE, path) => {
            let encoded = path
                .strip_prefix("/setup/butler-account/devices/")
                .filter(|id| !id.is_empty() && !id.contains('/'))
                .ok_or_else(not_found)?;
            ButlerAccountRequest::RevokeDevice {
                id: decode_component(encoded)?,
            }
        }
        _ => return Err(not_found()),
    };
    envelope(StatusCode::OK, setup.butler_account(operation).await?)
}
