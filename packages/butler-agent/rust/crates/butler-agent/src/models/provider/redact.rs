use serde_json::Value;

use crate::btcc::ProviderRequestError;

pub(super) fn redact_local_error(error: &mut ProviderRequestError, secret: &str) {
    if secret.is_empty() {
        return;
    }
    error.message = redact_text(&error.message, secret);
    error.provider = redact_text(&error.provider, secret);
    error.api = redact_text(&error.api, secret);
    error.endpoint = error
        .endpoint
        .take()
        .map(|value| redact_text(&value, secret));
    error.model = error.model.take().map(|value| redact_text(&value, secret));
    error.cause = error.cause.take().map(|value| redact_text(&value, secret));
    error.timeout_kind = error
        .timeout_kind
        .take()
        .map(|value| redact_text(&value, secret));
    error.retry_at = error
        .retry_at
        .take()
        .map(|value| redact_text(&value, secret));
    error.provider_request_id = error
        .provider_request_id
        .take()
        .map(|value| redact_text(&value, secret));
    error.provider_error_code = error
        .provider_error_code
        .take()
        .map(|value| redact_text(&value, secret));
    error.provider_error_type = error
        .provider_error_type
        .take()
        .map(|value| redact_text(&value, secret));
    error.rate_limit = error
        .rate_limit
        .take()
        .map(|value| Box::new(redact_value(*value, secret)));
    error.provider_error_details = error
        .provider_error_details
        .take()
        .map(|value| Box::new(redact_value(*value, secret)));
}

fn redact_text(value: &str, secret: &str) -> String {
    value.replace(secret, "[REDACTED]")
}

fn redact_value(value: Value, secret: &str) -> Value {
    match value {
        Value::String(value) => Value::String(redact_text(&value, secret)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| redact_value(value, secret))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (redact_text(&key, secret), redact_value(value, secret)))
                .collect(),
        ),
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_failure_projection_removes_the_exact_bearer_secret() {
        let mut error = ProviderRequestError {
            code: "provider_api_error".into(),
            message: "request failed".into(),
            provider: "local".into(),
            api: "chat_completions".into(),
            status_code: Some(401),
            endpoint: None,
            model: None,
            retryable: false,
            cause: Some("server echoed top-secret in its response".into()),
            request_generation: None,
            measured_input_tokens: None,
            registered_input_capacity: None,
            request_hash: None,
            timeout_kind: None,
            retry_at: None,
            provider_request_id: None,
            rate_limit: None,
            provider_error_code: None,
            provider_error_type: None,
            provider_error_details: Some(Box::new(serde_json::json!({
                "message":"Bearer top-secret was rejected"
            }))),
        };
        redact_local_error(&mut error, "top-secret");
        let encoded = serde_json::to_string(&error).unwrap();
        assert!(!encoded.contains("top-secret"));
        assert!(encoded.contains("[REDACTED]"));
    }
}
