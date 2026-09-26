use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde::de::DeserializeOwned;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, read_body_with_limit};
use crate::gateway::{
    CreateAutomationRequest, UpdateAutomationRequest,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = uri.path();
    if method == Method::GET && path == "/automations" {
        let target_session_id = query_value(uri, "target_session_id");
        return json(
            StatusCode::OK,
            state
                .application
                .list_automations(target_session_id)
                .await?,
        );
    }
    if method == Method::POST && path == "/automations" {
        let input: CreateAutomationRequest = body(request).await?;
        return json(
            StatusCode::CREATED,
            state.application.create_automation(input).await?,
        );
    }
    if method == Method::POST && path == "/automations/dispatch-due" {
        return json(
            StatusCode::ACCEPTED,
            state.application.dispatch_due_automations().await?,
        );
    }
    let suffix = path.strip_prefix("/automations/").ok_or_else(not_found)?;
    if method == Method::GET
        && let Some(id) = suffix.strip_suffix("/runs")
    {
        return json(
            StatusCode::OK,
            state.application.list_automation_runs(decode(id)?).await?,
        );
    }
    if method == Method::POST
        && let Some(id) = suffix.strip_suffix("/run")
    {
        return json(
            StatusCode::ACCEPTED,
            state.application.run_automation(decode(id)?).await?,
        );
    }
    if method == Method::POST
        && let Some(id) = suffix.strip_suffix("/pause")
    {
        return json(
            StatusCode::ACCEPTED,
            state
                .application
                .update_automation(
                    decode(id)?,
                    UpdateAutomationRequest {
                        state: Some("paused".into()),
                        ..Default::default()
                    },
                )
                .await?,
        );
    }
    if method == Method::POST
        && let Some(id) = suffix.strip_suffix("/resume")
    {
        return json(
            StatusCode::ACCEPTED,
            state
                .application
                .update_automation(
                    decode(id)?,
                    UpdateAutomationRequest {
                        state: Some("enabled".into()),
                        ..Default::default()
                    },
                )
                .await?,
        );
    }
    if suffix.contains('/') {
        return Err(not_found());
    }
    let id = decode(suffix)?;
    match method {
        Method::GET => json(StatusCode::OK, state.application.get_automation(id).await?),
        Method::PATCH => {
            let input: UpdateAutomationRequest = body(request).await?;
            json(
                StatusCode::OK,
                state.application.update_automation(id, input).await?,
            )
        }
        Method::DELETE => json(
            StatusCode::OK,
            state.application.delete_automation(id).await?,
        ),
        _ => Err(not_found()),
    }
}
async fn body<T: DeserializeOwned>(request: Request<Body>) -> Result<T, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}
fn decode(value: &str) -> Result<String, HttpError> {
    super::subsessions::decode_component(value)
}
fn query_value(uri: &Uri, key: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query()?.as_bytes())
        .find_map(|(name, value)| (name == key && !value.is_empty()).then(|| value.into_owned()))
}
fn not_found() -> HttpError {
    HttpError::public(404, "not_found", "Route not found.")
}
fn json<T: serde::Serialize>(status: StatusCode, data: T) -> Result<Response, HttpError> {
    super::json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}
