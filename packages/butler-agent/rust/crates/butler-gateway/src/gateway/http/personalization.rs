use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use crate::gateway::{
    AppPersonalizationCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

use super::{HttpError, HttpState, json, read_body_with_limit};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let locale = query_locale(uri);
    let (command, status) = match (request.method(), uri.path()) {
        (&Method::GET, "/personalization") => {
            (AppPersonalizationCommand::Read { locale }, StatusCode::OK)
        }
        (&Method::GET, "/personalization/profile-import-prompt") => {
            (AppPersonalizationCommand::Prompt { locale }, StatusCode::OK)
        }
        (&Method::PATCH, "/personalization") => {
            let input = body_json(request).await?;
            if !personalization_update(&input) {
                return Err(HttpError::public(
                    400,
                    "invalid_personalization_request",
                    "Personalization update contains unsupported fields.",
                ));
            }
            (AppPersonalizationCommand::Update { input }, StatusCode::OK)
        }
        (&Method::POST, "/personalization/profile-import") => {
            let input = body_json(request).await?;
            if !profile_import(&input) {
                return Err(HttpError::public(
                    400,
                    "invalid_personalization_profile_import",
                    "Profile import requires text and optional source/model.",
                ));
            }
            (
                AppPersonalizationCommand::Import { input, locale },
                StatusCode::OK,
            )
        }
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    let data = state
        .application
        .personalization(command, state.shutdown.child_token())
        .await?;
    json(
        status,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

async fn body_json(request: axum::http::Request<Body>) -> Result<Value, HttpError> {
    let bytes = read_body_with_limit(request.into_body(), 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|_| HttpError::invalid_json())
}

fn query_locale(uri: &Uri) -> String {
    uri.query()
        .into_iter()
        .flat_map(|query| url::form_urlencoded::parse(query.as_bytes()))
        .find(|(key, _)| key == "locale")
        .map(|(_, value)| if value == "ko" { "ko" } else { "en" }.to_owned())
        .unwrap_or_else(|| "en".into())
}

fn personalization_update(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input.keys().all(|key| {
        matches!(
            key.as_str(),
            "persona" | "eol" | "response_language" | "profile" | "profiling"
        )
    }) && input.get("persona").is_none_or(Value::is_string)
        && input.get("eol").is_none_or(Value::is_string)
        && input
            .get("response_language")
            .is_none_or(|value| matches!(value.as_str(), Some("en" | "ko")))
        && input.get("profile").is_none_or(profile_update)
        && input.get("profiling").is_none_or(profiling_update)
}

fn profile_update(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input.keys().all(|key| {
        matches!(
            key.as_str(),
            "butler_nickname" | "principal_name" | "preferred_address"
        )
    }) && input.values().all(Value::is_string)
}

fn profiling_update(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input.keys().all(|key| {
        matches!(
            key.as_str(),
            "mode" | "extractor_model" | "extractor_reasoning_effort" | "clear_profile"
        )
    }) && input
        .get("mode")
        .is_none_or(|value| matches!(value.as_str(), Some("off" | "basic" | "deep")))
        && input
            .get("clear_profile")
            .is_none_or(|value| matches!(value, Value::Bool(_)))
        && input.get("extractor_model").is_none_or(Value::is_string)
        && input.get("extractor_reasoning_effort").is_none_or(|value| {
            matches!(
                value.as_str(),
                Some("none" | "low" | "medium" | "high" | "xhigh" | "max")
            )
        })
}

fn profile_import(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    input
        .keys()
        .all(|key| matches!(key.as_str(), "source" | "text" | "model"))
        && input.get("text").is_some_and(Value::is_string)
        && input.get("source").is_none_or(Value::is_string)
        && input.get("model").is_none_or(Value::is_string)
}

#[cfg(test)]
mod tests {
    use super::{personalization_update, profile_import};
    use serde_json::json;

    #[test]
    fn personalization_routes_reject_unknown_fields_and_preserve_source_shapes() {
        assert!(personalization_update(&json!({
            "persona":"voice",
            "profile":{"principal_name":"Alex"},
            "profiling":{"mode":"basic","clear_profile":false},
            "response_language":"ko"
        })));
        assert!(!personalization_update(&json!({"profile":{"secret":"x"}})));
        assert!(profile_import(
            &json!({"text":"export","source":"assistant"})
        ));
        assert!(!profile_import(
            &json!({"text":"export","raw_text_included":true})
        ));
    }
}
