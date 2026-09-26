use super::super::StorageResult;
use super::super::common::{error, stringify};
use serde_json::{Map, Value};

pub(super) fn normalize(value: &Value) -> StorageResult<Value> {
    let source = value.as_object().ok_or_else(|| {
        error(
            "model_response_invalid",
            "accepted response must be an object",
        )
    })?;
    let calls = source
        .get("toolCalls")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            error(
                "model_response_invalid",
                "accepted response has invalid normalized shape",
            )
        })?;
    let mut out = Map::new();
    out.insert(
        "toolCalls".into(),
        Value::Array(calls.iter().map(tool_call).collect::<StorageResult<_>>()?),
    );
    if let Some(v) = source.get("text").filter(|v| v.is_string()) {
        out.insert("text".into(), v.clone());
    }
    if let Some(names) = source.get("textToolCallNames") {
        let values = names
            .as_array()
            .ok_or_else(|| error("model_response_invalid", "invalid text tool names"))?;
        if values.iter().any(|v| !v.is_string()) {
            return Err(error("model_response_invalid", "invalid text tool name"));
        }
        out.insert("textToolCallNames".into(), names.clone());
    }
    let bounded = source
        .get("continuation")
        .and_then(Value::as_object)
        .is_some_and(|v| {
            v.contains_key("deliveredThroughOrdinal") || v.contains_key("boundedItemKeys")
        });
    if let Some(v) = source.get("assistantMessage") {
        out.insert("assistantMessage".into(), assistant(v, !bounded)?);
    }
    if let Some(v) = source.get("continuation") {
        out.insert(
            "continuation".into(),
            if bounded {
                bounded_continuation(v)?
            } else {
                json_clone(v)?
            },
        );
    }
    if let Some(v) = source.get("usage") {
        if v.is_null() {
            out.insert("usage".into(), Value::Null);
        } else {
            let o = v
                .as_object()
                .ok_or_else(|| error("model_response_invalid", "invalid usage"))?;
            let mut usage = Map::new();
            for key in [
                "model",
                "promptTokens",
                "cachedTokens",
                "totalTokens",
                "outputTokens",
            ] {
                if let Some(v) = o.get(key) {
                    usage.insert(key.into(), v.clone());
                }
            }
            out.insert("usage".into(), Value::Object(usage));
        }
    }
    if let Some(v) = source.get("providerIdentity") {
        out.insert("providerIdentity".into(), provider_identity(v)?);
    }
    Ok(Value::Object(out))
}

fn tool_call(v: &Value) -> StorageResult<Value> {
    let o = v
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid tool call"))?;
    for k in ["id", "name", "rawArguments"] {
        if !o.get(k).is_some_and(Value::is_string) {
            return Err(error("model_response_invalid", "invalid tool call"));
        }
    }
    if !o.get("arguments").is_some_and(Value::is_object) {
        return Err(error("model_response_invalid", "invalid tool arguments"));
    }
    let mut n = Map::new();
    for k in ["id", "name", "arguments", "rawArguments"] {
        n.insert(k.into(), json_clone(&o[k])?);
    }
    if o.get("origin")
        .and_then(Value::as_str)
        .is_some_and(|v| matches!(v, "native" | "text"))
    {
        n.insert("origin".into(), o["origin"].clone());
    }
    Ok(Value::Object(n))
}
fn assistant(v: &Value, retain: bool) -> StorageResult<Value> {
    let o = v
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid assistant message"))?;
    if !o
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|v| matches!(v, "system" | "user" | "assistant" | "tool"))
        || !o.get("content").is_some_and(Value::is_string)
    {
        return Err(error("model_response_invalid", "invalid assistant message"));
    }
    let mut n = Map::new();
    for k in ["role", "content"] {
        n.insert(k.into(), o[k].clone());
    }
    for k in ["toolCallId", "name"] {
        if o.get(k).is_some_and(Value::is_string) {
            n.insert(k.into(), o[k].clone());
        }
    }
    if let Some(value) = o.get("toolCalls") {
        let calls = value
            .as_array()
            .ok_or_else(|| error("model_response_invalid", "invalid assistant tool calls"))?;
        n.insert(
            "toolCalls".into(),
            Value::Array(calls.iter().map(tool_call).collect::<StorageResult<_>>()?),
        );
    }
    if retain && let Some(p) = o.get("providerData") {
        n.insert("providerData".into(), json_clone(p)?);
    }
    Ok(Value::Object(n))
}
fn provider_identity(v: &Value) -> StorageResult<Value> {
    let o = v
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid provider identity"))?;
    let mut n = Map::new();
    for k in ["provider", "configuredModel", "reportedModel"] {
        if !o.get(k).is_some_and(Value::is_string) {
            return Err(error("model_response_invalid", "invalid provider identity"));
        }
        n.insert(k.into(), o[k].clone());
    }
    Ok(Value::Object(n))
}
fn bounded_continuation(v: &Value) -> StorageResult<Value> {
    let o = v
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid bounded continuation"))?;
    let allowed = [
        "provider",
        "responseId",
        "deliveredThroughOrdinal",
        "providerRouteIdentity",
        "contextProjection",
        "toolSurfaceDigest",
    ];
    if o.keys().any(|k| !allowed.contains(&k.as_str()))
        || o.get("provider").and_then(Value::as_str) != Some("openai")
        || !o
            .get("responseId")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && utf16_len(v) <= 200)
    {
        return Err(error(
            "model_response_invalid",
            "invalid bounded continuation",
        ));
    }
    if o.get("deliveredThroughOrdinal")
        .and_then(Value::as_u64)
        .is_none_or(|v| v > 1_000_000)
    {
        return Err(error(
            "model_response_invalid",
            "invalid bounded continuation watermark",
        ));
    }
    let mut n = Map::new();
    n.insert("provider".into(), Value::String("openai".into()));
    n.insert("responseId".into(), o["responseId"].clone());
    n.insert(
        "deliveredThroughOrdinal".into(),
        o["deliveredThroughOrdinal"].clone(),
    );
    if let Some(value) = o.get("providerRouteIdentity") {
        n.insert(
            "providerRouteIdentity".into(),
            provider_route_identity(value)?,
        );
    }
    if let Some(value) = o.get("contextProjection") {
        n.insert("contextProjection".into(), context_projection(value)?);
    }
    if let Some(value) = o.get("toolSurfaceDigest") {
        if !value.as_str().is_some_and(digest) {
            return Err(error(
                "model_response_invalid",
                "invalid tool surface digest",
            ));
        }
        n.insert("toolSurfaceDigest".into(), value.clone());
    }
    Ok(Value::Object(n))
}

fn provider_route_identity(value: &Value) -> StorageResult<Value> {
    let o = value
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid provider route identity"))?;
    let valid = o.get("schemaVersion").and_then(Value::as_str)
        == Some("butler.provider-route-cache-identity.v1")
        && o.get("routeDigest")
            .and_then(Value::as_str)
            .is_some_and(digest)
        && o.get("routeCursor")
            .and_then(Value::as_u64)
            .is_some_and(|v| v <= 9_007_199_254_740_991)
        && o.get("providerId")
            .and_then(Value::as_str)
            .is_some_and(|v| matches!(v, "openai" | "openai-codex"))
        && o.get("modelRef")
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty() && utf16_len(v) <= 200)
        && o.get("authMode")
            .and_then(Value::as_str)
            .is_some_and(|v| matches!(v, "api_key" | "codex_subscription" | "codex_oauth"))
        && o.get("capabilityDigest")
            .and_then(Value::as_str)
            .is_some_and(digest)
        && o.get("toolSurfaceDigest")
            .is_none_or(|v| v.as_str().is_some_and(digest))
        && o.get("serializerContract")
            .and_then(Value::as_str)
            .is_some_and(|v| {
                matches!(
                    v,
                    "butler.openai-responses-final-json.v1" | "butler.openai-codex-final-json.v1"
                )
            })
        && o.get("toolProfileRevision")
            .and_then(Value::as_str)
            .is_some_and(|v| utf16_len(v) <= 120)
        && o.get("stablePrefixRevision")
            .and_then(Value::as_str)
            .is_some_and(|v| utf16_len(v) <= 120)
        && o.get("serializedStablePrefixSha256")
            .and_then(Value::as_str)
            .is_some_and(digest)
        && o.get("serializedStablePrefixBytes")
            .and_then(Value::as_u64)
            .is_some_and(|v| (1..=1_000_000).contains(&v));
    if !valid {
        return Err(error(
            "model_response_invalid",
            "invalid provider route identity",
        ));
    }
    json_clone(value)
}

fn context_projection(value: &Value) -> StorageResult<Value> {
    let o = value
        .as_object()
        .ok_or_else(|| error("model_response_invalid", "invalid context projection"))?;
    let allowed = [
        "schemaVersion",
        "projectionRevision",
        "projectionDigest",
        "projectedThroughOrdinal",
    ];
    let valid = o.keys().all(|k| allowed.contains(&k.as_str()))
        && o.get("schemaVersion").and_then(Value::as_str)
            == Some("butler.context-projection-rebase.v1")
        && o.get("projectionRevision")
            .and_then(Value::as_str)
            .is_some_and(|v| {
                matches!(
                    v,
                    "butler.phase-continuity-projection.v1" | "butler.rolling-context.v1"
                )
            })
        && o.get("projectionDigest")
            .and_then(Value::as_str)
            .is_some_and(digest)
        && o.get("projectedThroughOrdinal")
            .and_then(Value::as_u64)
            .is_some_and(|v| v <= 1_000_000);
    if !valid {
        return Err(error(
            "model_response_invalid",
            "invalid context projection",
        ));
    }
    json_clone(value)
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}
fn json_clone(v: &Value) -> StorageResult<Value> {
    let bytes = stringify(v)?;
    serde_json::from_str(&bytes).map_err(|e| error("model_response_invalid", e.to_string()))
}
