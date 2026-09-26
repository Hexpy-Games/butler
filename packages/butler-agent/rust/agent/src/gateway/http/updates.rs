use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode},
    response::Response,
};
use serde::Deserialize;

use crate::{
    gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
    operations::UpdateRequest,
};

use super::{HttpError, HttpState, json, read_body_with_limit};

const UPDATE_REQUEST_LIMIT: usize = 16 * 1024;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckBody {
    component: Option<String>,
    components: Option<Vec<String>>,
    channel: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyBody {
    component: String,
    channel: Option<String>,
    dry_run: Option<bool>,
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let result = match (method, path.as_str()) {
        (Method::GET, "/updates") => {
            state
                .application
                .check_app_update(UpdateRequest::default())
                .await?
        }
        (Method::POST, "/updates/check") => {
            let body = read_body_with_limit(request.into_body(), UPDATE_REQUEST_LIMIT).await?;
            let input: CheckBody = if body.is_empty() || body.as_ref() == b"null" {
                CheckBody::default()
            } else {
                serde_json::from_slice(&body).map_err(|_| invalid_check())?
            };
            state
                .application
                .check_app_update(UpdateRequest {
                    component: input.component,
                    components: input.components,
                    channel: input.channel,
                    ..UpdateRequest::default()
                })
                .await?
        }
        (Method::POST, "/updates/apply") => {
            let body = read_body_with_limit(request.into_body(), UPDATE_REQUEST_LIMIT).await?;
            let input: ApplyBody = serde_json::from_slice(&body).map_err(|_| invalid_apply())?;
            state
                .application
                .apply_app_update(UpdateRequest {
                    component: Some(input.component),
                    channel: input.channel,
                    dry_run: input.dry_run.unwrap_or(false),
                    ..UpdateRequest::default()
                })
                .await?
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data: result,
        },
    )
}

fn invalid_check() -> HttpError {
    HttpError::public(
        400,
        "invalid_update_check",
        "Update check request contains unsupported fields.",
    )
}
fn invalid_apply() -> HttpError {
    HttpError::public(
        400,
        "invalid_update_apply",
        "Update apply request requires a supported component.",
    )
}
