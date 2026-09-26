use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::btcc::{ModelRoundError, ModelRoundRequest};

use super::super::contracts::{ProviderAuthMode, ProviderRequestConfig};

pub(super) fn order(
    mut body: Map<String, Value>,
    stable: &Value,
    instructions: Option<&str>,
) -> Result<Map<String, Value>, &'static str> {
    let prefix = stable
        .get("instructionPrefix")
        .and_then(Value::as_str)
        .ok_or("stable_provider_prefix_contract_invalid")?;
    let revisions_valid = ["stablePrefixRevision", "toolProfileRevision"]
        .into_iter()
        .all(|key| {
            stable
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(valid_revision)
        });
    if stable.get("schemaVersion").and_then(Value::as_str)
        != Some("butler.stable-provider-cache-prefix.v1")
        || !revisions_valid
        || prefix.is_empty()
        || prefix.len() > 200_000
    {
        return Err("stable_provider_prefix_contract_invalid");
    }
    if !instructions.is_some_and(|value| value.starts_with(prefix)) {
        return Err("stable_provider_prefix_instruction_mismatch");
    }
    let mut ordered = Map::new();
    for key in ["model", "tools", "tool_choice", "reasoning", "instructions"] {
        if let Some(value) = body.shift_remove(key) {
            ordered.insert(key.into(), value);
        }
    }
    ordered.extend(body);
    Ok(ordered)
}

pub(in crate::models::provider) fn identity(
    body: &Value,
    serialized: &str,
    request: &ModelRoundRequest<'_>,
    config: &ProviderRequestConfig,
) -> Result<Option<Value>, ModelRoundError> {
    let Some(stable) = request.stable_provider_cache_prefix else {
        return Ok(None);
    };
    let route = request
        .route_context
        .ok_or_else(|| invariant("stable_provider_prefix_route_context_missing"))?;
    if route.get("schemaVersion").and_then(Value::as_str) != Some("butler.model-route-request.v1")
        || !route
            .get("routeDigest")
            .and_then(Value::as_str)
            .is_some_and(digest)
        || !route
            .get("cursor")
            .and_then(Value::as_f64)
            .is_some_and(safe_integer)
        || !route
            .get("modelRef")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                !crate::public_text::trim_js_whitespace(value).is_empty() && value.len() <= 200
            })
        || route
            .get("toolSurfaceDigest")
            .is_some_and(|value| !value.as_str().is_some_and(digest))
    {
        return Err(invariant("stable_provider_prefix_route_context_invalid"));
    }
    if route.get("modelRef").and_then(Value::as_str) != Some(request.model) {
        return Err(invariant("stable_provider_prefix_route_model_mismatch"));
    }
    let prior_continuation = request
        .continuation
        .filter(|value| value.get("provider").and_then(Value::as_str) == Some("openai"));
    let prior_identity = prior_continuation.and_then(|value| value.get("providerRouteIdentity"));
    if prior_continuation.is_some() && prior_identity.is_none() {
        return Err(invariant(
            "stable_provider_prefix_previous_identity_missing",
        ));
    }
    let changed_tool_surface = prior_continuation.is_some_and(|continuation| {
        continuation
            .get("toolSurfaceDigest")
            .and_then(Value::as_str)
            .is_some()
            && route
                .get("toolSurfaceDigest")
                .and_then(Value::as_str)
                .is_some()
            && continuation
                .get("toolSurfaceDigest")
                .and_then(Value::as_str)
                != route.get("toolSurfaceDigest").and_then(Value::as_str)
    });
    let previous = (!changed_tool_surface).then_some(prior_identity).flatten();
    let object = body
        .as_object()
        .ok_or_else(|| invariant("stable_provider_prefix_serializer_order_invalid"))?;
    let prefix = stable["instructionPrefix"].as_str().unwrap_or_default();
    let mut prefix_body = Map::new();
    for (key, value) in object {
        prefix_body.insert(
            key.clone(),
            if key == "instructions" {
                Value::String(prefix.into())
            } else {
                value.clone()
            },
        );
        if key == "instructions" {
            break;
        }
    }
    let encoded = crate::json::stringify(&Value::Object(prefix_body))
        .map_err(|_| invariant("stable_provider_prefix_serializer_order_invalid"))?;
    let quoted = crate::json::stringify(&Value::String(prefix.into()))
        .map_err(|_| invariant("stable_provider_prefix_serializer_order_invalid"))?;
    let suffix = format!("{quoted}}}");
    if !encoded.ends_with(&suffix) {
        return Err(invariant("stable_provider_prefix_serializer_order_invalid"));
    }
    let stable_bytes = encoded
        .get(..encoded.len().saturating_sub(2))
        .ok_or_else(|| invariant("stable_provider_prefix_serializer_order_invalid"))?;
    if !serialized.starts_with(stable_bytes) {
        return Err(invariant("stable_provider_prefix_final_bytes_mismatch"));
    }
    let tools = object
        .get("tools")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let capability = crate::json::stringify(&tools)
        .map_err(|_| invariant("stable_provider_prefix_serializer_order_invalid"))?;
    let (provider_id, auth_mode, serializer) = match config.auth.mode() {
        ProviderAuthMode::ApiKey => ("openai", "api_key", "butler.openai-responses-final-json.v1"),
        ProviderAuthMode::CodexSubscription => (
            "openai-codex",
            "codex_subscription",
            "butler.openai-codex-final-json.v1",
        ),
        ProviderAuthMode::CodexOauth => (
            "openai-codex",
            "codex_oauth",
            "butler.openai-codex-final-json.v1",
        ),
        ProviderAuthMode::None => {
            return Err(invariant("stable_provider_prefix_contract_invalid"));
        }
    };
    let mut identity = Map::new();
    identity.insert(
        "schemaVersion".into(),
        "butler.provider-route-cache-identity.v1".into(),
    );
    identity.insert("routeDigest".into(), route["routeDigest"].clone());
    identity.insert("routeCursor".into(), route["cursor"].clone());
    identity.insert("providerId".into(), provider_id.into());
    identity.insert(
        "modelRef".into(),
        object
            .get("model")
            .cloned()
            .unwrap_or_else(|| route["modelRef"].clone()),
    );
    identity.insert("authMode".into(), auth_mode.into());
    identity.insert("capabilityDigest".into(), hash(&capability).into());
    if let Some(value) = route.get("toolSurfaceDigest") {
        identity.insert("toolSurfaceDigest".into(), value.clone());
    }
    identity.insert("serializerContract".into(), serializer.into());
    identity.insert(
        "toolProfileRevision".into(),
        stable["toolProfileRevision"].clone(),
    );
    identity.insert(
        "stablePrefixRevision".into(),
        stable["stablePrefixRevision"].clone(),
    );
    identity.insert(
        "serializedStablePrefixSha256".into(),
        hash(stable_bytes).into(),
    );
    identity.insert(
        "serializedStablePrefixBytes".into(),
        stable_bytes.len().into(),
    );
    let identity = Value::Object(identity);
    if let Some(previous) = previous {
        let old = crate::json::stringify(previous).ok();
        let current = crate::json::stringify(&identity).ok();
        if old != current {
            return Err(invariant("stable_provider_prefix_route_identity_mismatch"));
        }
    }
    Ok(Some(identity))
}

fn invariant(code: &'static str) -> ModelRoundError {
    ModelRoundError::StablePrefix(code.into())
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}
fn safe_integer(value: f64) -> bool {
    value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
}
fn valid_revision(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && (value.as_bytes()[0].is_ascii_lowercase() || value.as_bytes()[0].is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}
