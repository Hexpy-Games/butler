//! Request-only cache diagnostics. No content, session names, endpoints or keys
//! enter the metric. Prior bytes exist only in a bounded in-memory LRU.

use std::collections::VecDeque;

use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ProviderRequestConfig;
use butler_turn::btcc::ModelRoundError;

const HISTORY_BYTES: usize = 32 * 1024 * 1024;
const HISTORY_SESSIONS: usize = 128;

#[derive(Default)]
pub(super) struct History(Mutex<VecDeque<(String, Bytes)>>);

pub(super) struct Prepared {
    prefix: Bytes,
    metadata: Value,
}

pub(super) fn prepare(
    body: &Value,
    config: &ProviderRequestConfig,
) -> Result<Prepared, ModelRoundError> {
    let mut prefix = Vec::new();
    let mut components = Vec::new();
    for name in [
        "model",
        "tools",
        "tool_choice",
        "reasoning",
        "instructions",
        "system",
        "systemInstruction",
    ] {
        component(
            name,
            None,
            body.get(name).unwrap_or(&Value::Null),
            &mut prefix,
            &mut components,
        )?;
    }
    let input = body
        .get("input")
        .or_else(|| body.get("messages"))
        .or_else(|| body.get("contents"));
    match input {
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                component("input", Some(index), item, &mut prefix, &mut components)?;
            }
        }
        Some(item) => component("input", Some(0), item, &mut prefix, &mut components)?,
        None => {}
    }
    let key = body
        .get("prompt_cache_key")
        .and_then(Value::as_str)
        .map(hash);
    Ok(Prepared {
        metadata: json!({
            "representation":"serialized-components-v1", "components":components,
            "prefixBytes":prefix.len(), "prefixSha256":hash(&prefix),
            "promptCacheKeySha256":key, "providerReportedCachedTokens":null,
            "providerCachedTokensFieldPresent":null,
            "providerId":config.metadata.provider_id, "authMode":format!("{:?}",config.auth.mode()),
            "endpointSha256":hash(config.endpoint.as_str()),
        }),
        prefix: Bytes::from(prefix),
    })
}

fn component(
    name: &str,
    index: Option<usize>,
    value: &Value,
    prefix: &mut Vec<u8>,
    components: &mut Vec<Value>,
) -> Result<(), ModelRoundError> {
    let encoded = butler_core::json::stringify(value).map_err(|_| {
        ModelRoundError::StablePrefix("prefix_diagnostic_serialization_failed".into())
    })?;
    let offset = prefix.len();
    prefix.extend_from_slice(encoded.as_bytes());
    // Delimit components rather than closing an input array on every request:
    // appending a conversation item preserves the previous reconstructed prefix.
    prefix.push(b'\n');
    components.push(json!({"component":name,"index":index,"bytes":encoded.len(),"sha256":hash(&encoded),"offset":offset}));
    Ok(())
}

impl History {
    pub(super) fn observe(&self, scope: Option<&str>, mut current: Prepared) -> Value {
        // Unscoped calls cannot be attributed to the same session safely.
        let Some(scope) = scope else {
            return current.metadata;
        };
        let identity = hash(scope);
        let mut history = self.0.lock();
        if let Some(index) = history.iter().position(|(key, _)| *key == identity)
            && let Some((_, previous)) = history.remove(index)
        {
            let lcp = previous
                .iter()
                .zip(current.prefix.iter())
                .take_while(|(a, b)| a == b)
                .count();
            current.metadata["previousPrefixBytes"] = previous.len().into();
            current.metadata["lcpBytes"] = lcp.into();
            current.metadata["appendOnly"] = (lcp == previous.len()).into();
            current.metadata["lcpPercent"] =
                json!(100.0 * lcp as f64 / previous.len().max(1) as f64);
            current.metadata["firstDifference"] = current.metadata["components"]
                .as_array()
                .and_then(|items| {
                    items.iter().find(|item| {
                        let end = item["offset"].as_u64().unwrap_or(0)
                            + item["bytes"].as_u64().unwrap_or(0)
                            + 1;
                        u64::try_from(lcp).unwrap_or(u64::MAX) < end
                    })
                })
                .map(|item| json!({"component":item["component"],"index":item["index"]}))
                .unwrap_or(Value::Null);
        }
        if current.prefix.len() <= HISTORY_BYTES {
            let mut bytes = history
                .iter()
                .map(|(_, prefix)| prefix.len())
                .sum::<usize>();
            while history.len() >= HISTORY_SESSIONS || bytes + current.prefix.len() > HISTORY_BYTES
            {
                if let Some((_, evicted)) = history.pop_front() {
                    bytes -= evicted.len();
                } else {
                    break;
                }
            }
            history.push_back((identity, current.prefix));
        }
        current.metadata
    }
}

fn hash(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

pub(super) fn cached_tokens(response: &Value) -> Value {
    [
        "/usage/prompt_tokens_details/cached_tokens",
        "/usage/input_tokens_details/cached_tokens",
        "/usage/cache_read_input_tokens",
        "/usageMetadata/cachedContentTokenCount",
    ]
    .into_iter()
    .find_map(|path| response.pointer(path).filter(|value| value.is_number()))
    .cloned()
    .unwrap_or(Value::Null)
}

pub(super) fn cached_tokens_present(response: &Value) -> Value {
    response
        .pointer("/usage/provider_cached_tokens_present")
        .cloned()
        .unwrap_or_else(|| {
            Value::Bool(
                [
                    "/usage/prompt_tokens_details/cached_tokens",
                    "/usage/input_tokens_details/cached_tokens",
                    "/usage/cache_read_input_tokens",
                    "/usageMetadata/cachedContentTokenCount",
                ]
                .into_iter()
                .any(|path| response.pointer(path).is_some()),
            )
        })
}
