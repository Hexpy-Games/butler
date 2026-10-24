//! Official ChatGPT plan errors precede provider-agnostic heuristics.
use serde_json::Value;
pub(super) fn classify(
    api: &str,
    status: u16,
    body: Option<&Value>,
) -> Option<(&'static str, bool)> {
    if api != "chatgpt_plan_responses" && api != "chatgpt_plan_models" {
        return None;
    }
    let body = body?;
    let error = body.get("error").unwrap_or(body);
    let code = error.get("code").and_then(Value::as_str).unwrap_or("");
    match (status, code) {
        (401, _) => Some(("provider_auth_error", false)),
        (
            503,
            "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable",
        ) => Some(("provider_plan_usage_unavailable", true)),
        (503, _) if body.get("detail").is_some() => Some(("provider_plan_usage_unavailable", true)),
        (403, "subscription_sharing_user_not_eligible") => {
            Some(("provider_plan_not_eligible", false))
        }
        (403, "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context") => {
            Some(("provider_plan_not_authorized", false))
        }
        (403, _) if body.get("detail").is_some() => Some(("provider_plan_not_authorized", false)),
        (403, "subscription_sharing_route_not_supported") => {
            Some(("provider_route_not_supported", false))
        }
        (400, "subscription_sharing_unsupported_capability") => {
            Some(("provider_unsupported_capability", false))
        }
        _ => None,
    }
}
pub(in crate::models) fn stream_status(error: &Value) -> Option<u16> {
    match error["code"].as_str()? {
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
            Some(503)
        }
        "subscription_sharing_invalid_user" => Some(401),
        "subscription_sharing_user_not_eligible"
        | "chatpass_v2_scope_not_authorized"
        | "chatpass_v2_invalid_authorization_context"
        | "subscription_sharing_route_not_supported" => Some(403),
        "subscription_sharing_unsupported_capability" => Some(400),
        _ => None,
    }
}

pub(in crate::models) fn incomplete(
    event: &Value,
    provider: &str,
    api: &str,
) -> Box<butler_turn::btcc::ProviderRequestError> {
    let mut error = super::protocol(provider, api, "provider_response_incomplete");
    error.cause = event
        .pointer("/response/incomplete_details/reason")
        .and_then(Value::as_str)
        .and_then(super::safe_text);
    Box::new(error)
}
