//! Public session controls and Plan decision routes over the App owner.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, Request, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, read_body_with_limit};
use crate::gateway::{
    AppPlanDecisionAction, AppPlanDecisionRequest, AppSessionControlUpdate,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
    uri: &Uri,
) -> Result<Option<Response>, HttpError> {
    let Some(path) = uri.path().strip_prefix("/sessions/") else {
        return Ok(None);
    };
    if let Some(encoded) = path.strip_suffix("/controls")
        && !encoded.is_empty()
        && !encoded.contains('/')
    {
        let session_id = super::subsessions::decode_component(encoded)?;
        let method = request.method().clone();
        let data = match method {
            Method::GET => {
                state
                    .application
                    .get_session_controls_view(session_id)
                    .await?
            }
            Method::PATCH => {
                let body = parse_body(request).await?;
                state
                    .application
                    .update_session_controls_view(session_id, controls_update(&body)?)
                    .await?
            }
            _ => return Ok(None),
        };
        return json(
            StatusCode::OK,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data,
            },
        )
        .map(Some);
    }
    let Some((encoded_session, encoded_plan)) = path.split_once("/plan-decisions/") else {
        return Ok(None);
    };
    if request.method() != Method::POST
        || encoded_session.is_empty()
        || encoded_session.contains('/')
        || encoded_plan.is_empty()
        || encoded_plan.contains('/')
    {
        return Ok(None);
    }
    let session_id = super::subsessions::decode_component(encoded_session)?;
    let plan_id = super::subsessions::decode_component(encoded_plan)?;
    let body = parse_body(request).await?;
    let decision = plan_decision(&body)?;
    let data = state
        .application
        .decide_session_plan(session_id, plan_id, decision)
        .await?;
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
    .map(Some)
}

fn controls_update(value: &Value) -> Result<AppSessionControlUpdate, HttpError> {
    let invalid = || {
        HttpError::public(
            400,
            "invalid_session_controls",
            "Session controls update contains unsupported fields.",
        )
    };
    let object = value.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "model" | "reasoning_effort" | "access_mode" | "plan_mode"
        )
    }) || object.get("model").is_some_and(|v| !v.is_string())
        || object.get("reasoning_effort").is_some_and(|v| {
            !matches!(
                v.as_str(),
                Some("none" | "low" | "medium" | "high" | "xhigh" | "max")
            )
        })
        || object
            .get("access_mode")
            .is_some_and(|v| !matches!(v.as_str(), Some("full_access" | "ask_first" | "read_only")))
        || object.get("plan_mode").is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid());
    }
    Ok(AppSessionControlUpdate {
        model: object
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
        reasoning_effort: object
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .map(str::to_owned),
        access_mode: object
            .get("access_mode")
            .and_then(Value::as_str)
            .map(str::to_owned),
        plan_mode: object.get("plan_mode").and_then(Value::as_bool),
    })
}

fn plan_decision(value: &Value) -> Result<AppPlanDecisionRequest, HttpError> {
    let invalid = || {
        HttpError::public(
            400,
            "invalid_plan_decision",
            "Plan decision action is required.",
        )
    };
    let object = value.as_object().ok_or_else(invalid)?;
    let action = match object.get("action").and_then(Value::as_str) {
        Some("accept") => AppPlanDecisionAction::Accept,
        Some("reject") => AppPlanDecisionAction::Reject,
        Some("instruct") => AppPlanDecisionAction::Instruct,
        _ => return Err(invalid()),
    };
    if object.get("instruction").is_some_and(|v| !v.is_string()) {
        return Err(invalid());
    }
    Ok(AppPlanDecisionRequest {
        action,
        instruction: object
            .get("instruction")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

async fn parse_body(request: Request<Body>) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}
