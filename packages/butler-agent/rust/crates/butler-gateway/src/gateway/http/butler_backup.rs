use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    response::Response,
};

use super::{
    Client, HttpError, security_settings,
    setup::{body, envelope, not_found},
};
use crate::gateway::{AppSetupPort, ButlerBackupRequest};

pub(super) async fn route(
    setup: &Arc<dyn AppSetupPort>,
    request: Request<Body>,
    path: &str,
) -> Result<Response, HttpError> {
    security_settings::local_client(request.extensions().get::<Client>())?;
    let operation = match (request.method(), path) {
        (&Method::GET, "/setup/butler-backup") => ButlerBackupRequest::Status,
        (&Method::POST, "/setup/butler-backup") => body(request).await?,
        _ => return Err(not_found()),
    };
    envelope(StatusCode::OK, setup.butler_backup(operation).await?)
}
