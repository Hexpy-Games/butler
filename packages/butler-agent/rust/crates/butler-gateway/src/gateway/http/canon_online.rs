use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    response::Response,
};

use super::{
    Client, HttpError, HttpState, security_settings,
    setup::{body, envelope, not_found},
};
use crate::gateway::{AppCanonRequest, AppCanonResource, AppSetupPort, CanonOnlineRequest};

pub(super) async fn route(
    state: &Arc<HttpState>,
    setup: &Arc<dyn AppSetupPort>,
    request: Request<Body>,
    path: &str,
) -> Result<Response, HttpError> {
    security_settings::local_client(request.extensions().get::<Client>())?;
    let op = match (request.method(), path) {
        (&Method::GET, "/setup/canon-online") => CanonOnlineRequest::Status,
        (&Method::POST, "/setup/canon-online") => body(request).await?,
        _ => return Err(not_found()),
    };
    if let CanonOnlineRequest::Link { project_id, .. }
    | CanonOnlineRequest::Join { project_id, .. } = &op
    {
        state
            .application
            .canon(AppCanonRequest {
                resource: AppCanonResource::Tags,
                id: project_id.clone(),
                input: None,
                delegate: None,
            })
            .await?;
    }
    envelope(StatusCode::OK, setup.canon_online(op).await?)
}
