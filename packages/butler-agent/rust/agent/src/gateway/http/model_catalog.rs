use std::sync::Arc;

use axum::{
    body::Body,
    http::{Method, StatusCode, Uri},
    response::Response,
};
use serde_json::Value;

use crate::gateway::{
    AppModelCatalogCommand,
    protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
};

use super::{HttpError, HttpState, json, read_body_with_limit, subsessions::decode_component};

pub(super) async fn route(
    state: Arc<HttpState>,
    request: axum::http::Request<Body>,
    uri: &Uri,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let command = if method == Method::GET && uri.path() == "/model-catalog" {
        (AppModelCatalogCommand::Read, StatusCode::OK)
    } else if method == Method::POST && uri.path() == "/model-catalog/provider-credentials" {
        let input = body_json(request).await?;
        if !provider_credential(&input) {
            return Err(HttpError::public(
                400,
                "invalid_provider_credential",
                "Provider credential registration requires provider id and API key.",
            ));
        }
        (
            AppModelCatalogCommand::UpsertCredential(input),
            StatusCode::CREATED,
        )
    } else if method == Method::POST && uri.path() == "/model-catalog/registered-models" {
        let input = body_json(request).await?;
        if !hosted_registration(&input) {
            return Err(HttpError::public(
                400,
                "invalid_hosted_model_registration",
                "Hosted model registration requires provider, model, and supported auth.",
            ));
        }
        (
            AppModelCatalogCommand::RegisterHosted(input),
            StatusCode::CREATED,
        )
    } else if let Some(lookup) = hosted_id(uri.path())? {
        if method != Method::DELETE {
            return Err(not_found());
        }
        (AppModelCatalogCommand::DeleteHosted(lookup), StatusCode::OK)
    } else if method == Method::POST && uri.path() == "/model-catalog/local/discover" {
        let input = body_json(request).await?;
        if !local_discovery(&input) {
            return Err(HttpError::public(
                400,
                "invalid_local_model_discovery",
                "Local model discovery requires provider, API type, platform, and server URL.",
            ));
        }
        (AppModelCatalogCommand::DiscoverLocal(input), StatusCode::OK)
    } else if method == Method::POST && uri.path() == "/model-catalog/local-models" {
        let input = body_json(request).await?;
        if !local_registration(&input) {
            return Err(HttpError::public(
                400,
                "invalid_local_model_registration",
                "Local model registration requires server URL, model id, and context window.",
            ));
        }
        (
            AppModelCatalogCommand::RegisterLocal(input),
            StatusCode::CREATED,
        )
    } else if let Some(lookup) = local_id(uri.path())? {
        match method {
            Method::PATCH => {
                let input = body_json(request).await?;
                if !local_registration(&input) {
                    return Err(HttpError::public(
                        400,
                        "invalid_local_model_update",
                        "Local model update requires server URL, model id, and context window.",
                    ));
                }
                (
                    AppModelCatalogCommand::UpdateLocal { lookup, input },
                    StatusCode::OK,
                )
            }
            Method::DELETE => (AppModelCatalogCommand::DeleteLocal(lookup), StatusCode::OK),
            _ => return Err(not_found()),
        }
    } else {
        return Err(not_found());
    };
    let data = state
        .application
        .model_catalog(command.0, state.shutdown.child_token())
        .await?;
    json(
        command.1,
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

fn provider_credential(value: &Value) -> bool {
    object(value).is_some_and(|input| {
        hosted_provider(input.get("provider_id"))
            && input.get("auth_type").and_then(Value::as_str) == Some("api_key")
            && nonempty_string(input.get("api_key"))
            && optional_string(input.get("label"))
            && optional_string(input.get("credential_id"))
    })
}

fn hosted_registration(value: &Value) -> bool {
    object(value).is_some_and(|input| {
        let provider = input.get("provider_id");
        let model = input.get("model_id").and_then(Value::as_str);
        let auth = input.get("auth_type").and_then(Value::as_str);
        let credential = nonempty_string(input.get("credential_id"));
        let key = nonempty_string(input.get("api_key"));
        hosted_provider(provider)
            && model.is_some_and(|value| !value.trim().is_empty())
            && matches!(auth, Some("api_key") | Some("codex_oauth"))
            && !(auth == Some("codex_oauth") && provider.and_then(Value::as_str) != Some("openai"))
            && (auth != Some("api_key") || credential || key)
            && optional_string(input.get("display_name"))
            && optional_string(input.get("credential_id"))
            && optional_string(input.get("api_key"))
            && optional_string(input.get("credential_label"))
            && optional_string(input.get("api_base_url"))
    })
}

fn local_discovery(value: &Value) -> bool {
    object(value).is_some_and(|input| {
        input.get("provider_id").and_then(Value::as_str) == Some("local")
            && input.get("api_type").and_then(Value::as_str) == Some("openai_compatible")
            && local_platform(input.get("platform"))
            && nonempty_string(input.get("server_url"))
            && optional_string(input.get("model_ref"))
            && optional_api_key(input.get("api_key"))
    })
}

fn local_registration(value: &Value) -> bool {
    object(value).is_some_and(|input| {
        input.get("provider_id").and_then(Value::as_str) == Some("local")
            && input.get("api_type").and_then(Value::as_str) == Some("openai_compatible")
            && local_platform(input.get("platform"))
            && nonempty_string(input.get("server_url"))
            && nonempty_string(input.get("model_id"))
            && positive_number(input.get("context_window_tokens"))
            && optional_positive_number(input.get("max_output_tokens"))
            && optional_ratio(input.get("reasoning_budget_ratio"))
            && optional_string(input.get("display_name"))
            && optional_api_key(input.get("api_key"))
            && input
                .get("source")
                .is_none_or(|value| matches!(value.as_str(), Some("discovered" | "manual")))
    })
}

fn hosted_id(path: &str) -> Result<Option<String>, HttpError> {
    let Some(raw) = path.strip_prefix("/model-catalog/registered-models/") else {
        return Ok(None);
    };
    if raw.is_empty() || raw.split('/').count() > 2 || raw.split('/').any(str::is_empty) {
        return Ok(None);
    }
    decode_component(raw).map(Some)
}

fn local_id(path: &str) -> Result<Option<String>, HttpError> {
    let Some(raw) = path.strip_prefix("/model-catalog/local-models/") else {
        return Ok(None);
    };
    if raw.is_empty() || raw.contains('/') {
        return Ok(None);
    }
    decode_component(raw).map(Some)
}

fn object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}
fn nonempty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}
fn optional_string(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_string)
}
fn optional_api_key(value: Option<&Value>) -> bool {
    value.is_none_or(|value| {
        value.as_str().is_some_and(|value| {
            !value
                .chars()
                .any(|character| matches!(character, '\r' | '\n'))
        })
    })
}
fn hosted_provider(value: Option<&Value>) -> bool {
    matches!(
        value.and_then(Value::as_str),
        Some(
            "openai"
                | "anthropic"
                | "google"
                | "xai"
                | "qwen"
                | "kimi"
                | "zai"
                | "zai-api"
                | "opencode-go"
        )
    )
}
fn local_platform(value: Option<&Value>) -> bool {
    matches!(
        value.and_then(Value::as_str),
        Some("llama_cpp" | "ollama" | "lm_studio" | "custom")
    )
}
fn positive_number(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_f64)
        .is_some_and(|value| value.is_finite() && value > 0.0)
}
fn optional_positive_number(value: Option<&Value>) -> bool {
    value.is_none_or(|value| positive_number(Some(value)))
}
fn optional_ratio(value: Option<&Value>) -> bool {
    value.is_none_or(|value| {
        value
            .as_f64()
            .is_some_and(|value| value.is_finite() && (0.0..=1.0).contains(&value))
    })
}
fn not_found() -> HttpError {
    HttpError::public(404, "not_found", "Route not found.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_custom_requests_allow_empty_keys_but_reject_header_injection() {
        let discovery = json!({
            "provider_id":"local", "api_type":"openai_compatible",
            "platform":"custom", "server_url":"https://models.example/proxy/v1",
            "model_ref":"local/org-model", "api_key":""
        });
        assert!(local_discovery(&discovery));
        let mut bad_discovery = discovery;
        bad_discovery["api_key"] = Value::String("key\r\nInjected: yes".into());
        assert!(!local_discovery(&bad_discovery));

        let registration = json!({
            "provider_id":"local", "api_type":"openai_compatible",
            "platform":"custom", "server_url":"https://models.example/proxy/v1",
            "model_id":"org/model", "context_window_tokens":8192, "api_key":""
        });
        assert!(local_registration(&registration));
        let mut bad_registration = registration;
        bad_registration["api_key"] = Value::String("key\nInjected".into());
        assert!(!local_registration(&bad_registration));
    }
}
