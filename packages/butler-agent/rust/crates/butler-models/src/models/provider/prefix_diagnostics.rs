//! Request-only cache diagnostics. No content, session names, endpoints or keys
//! enter the metric. Prior bytes exist only in a bounded in-memory LRU.

use std::{collections::VecDeque, sync::Arc, time::Instant};

use bytes::Bytes;
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ProviderRequestConfig;
use butler_turn::btcc::ModelRoundError;

pub(super) mod components;

const HISTORY_BYTES: usize = 32 * 1024 * 1024;
const HISTORY_SESSIONS: usize = 128;

type PreviousPrefix = (String, Bytes, Arc<[u32]>, Instant);

#[derive(Default)]
pub(super) struct History {
    previous: Mutex<VecDeque<PreviousPrefix>>,
    components: Mutex<components::Cache>,
}

#[derive(Clone)]
pub(super) struct Prepared {
    prefix: Bytes,
    metadata: Value,
    tokens: Arc<[u32]>,
    source_index: Option<usize>,
    input: Option<(&'static str, std::ops::Range<usize>, bool)>,
}

fn prepare(
    body: &Value,
    config: &ProviderRequestConfig,
    cache: &mut components::Cache,
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
            cache,
        )?;
    }
    let input_field = ["input", "messages", "contents"]
        .into_iter()
        .find(|name| body.get(*name).is_some());
    let input = input_field.and_then(|name| body.get(name));
    let input_start = prefix.len();
    match input {
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                component(
                    "input",
                    Some(index),
                    item,
                    &mut prefix,
                    &mut components,
                    cache,
                )?;
            }
        }
        Some(item) => component("input", Some(0), item, &mut prefix, &mut components, cache)?,
        None => {}
    }
    let input = input_field.map(|name| {
        (
            name,
            input_start..prefix.len(),
            matches!(input, Some(Value::Array(_))),
        )
    });
    let key = body
        .get("prompt_cache_key")
        .and_then(Value::as_str)
        .map(hash);
    Ok(Prepared {
        metadata: json!({
            "representation":"serialized-components-v1", "components":components,
            "inputSections":layout_sections(&components, None, None), "turnId":null, "trigger":"other",
            "instructionComponents":{"persona":null,"onboarding":null,"reminders":null},
            "prefixBytes":prefix.len(),
            "promptCacheKeySha256":key, "providerReportedCachedTokens":null,
            "providerCachedTokensFieldPresent":null,
            "providerId":config.metadata.provider_id, "authMode":format!("{:?}",config.auth.mode()),
            "model":config.wire_model, "authRoute":auth_route(config.auth.mode()),
            "idleGapMs":null,
            "endpointSha256":hash(config.endpoint.as_str()),
        }),
        prefix: Bytes::from(prefix),
        tokens: Arc::from([]),
        source_index: source_index(body),
        input,
    })
}

fn component(
    name: &str,
    index: Option<usize>,
    value: &Value,
    prefix: &mut Vec<u8>,
    components: &mut Vec<Value>,
    cache: &mut components::Cache,
) -> Result<(), ModelRoundError> {
    let include_hash = !matches!(name, "input" | "instructions");
    let cached = cache.component(components.len(), value, include_hash)?;
    let encoded = &cached.encoded;
    let offset = prefix.len();
    prefix.extend_from_slice(encoded.as_bytes());
    // Delimit components rather than closing an input array on every request:
    // appending a conversation item preserves the previous reconstructed prefix.
    prefix.push(b'\n');
    let mut diagnostic =
        json!({"component":name,"index":index,"bytes":encoded.len(),"offset":offset});
    if let Some(hash) = &cached.hash {
        diagnostic["sha256"] = hash.clone().into();
    }
    components.push(diagnostic);
    Ok(())
}

impl Prepared {
    #[cfg(test)]
    pub(super) fn assert_matches(&self, other: &Self) {
        assert_eq!(self.prefix, other.prefix);
        assert_eq!(self.metadata, other.metadata);
        assert_eq!(self.input, other.input);
    }

    /// Use this preparation's immutable input components in the physical body.
    /// Both callers prepare and encode the same borrowed body before mutation.
    pub(super) fn body_json(&self, body: &Value) -> Result<String, butler_core::json::JsonError> {
        let (Some(object), Some((field, range, array))) = (body.as_object(), &self.input) else {
            return butler_core::json::stringify(body);
        };
        // Standard provider fields are named. Preserve JS property enumeration
        // through the shared codec for any unexpected numeric root keys.
        if object.keys().any(|key| key.parse::<u32>().is_ok()) {
            return butler_core::json::stringify(body);
        }
        let encoded = std::str::from_utf8(&self.prefix[range.clone()])
            .map_err(butler_core::json::JsonError::callback)?;
        let mut output = String::with_capacity(self.prefix.len());
        output.push('{');
        for (index, (key, value)) in object.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            butler_core::json::write_string(key, &mut output)?;
            output.push(':');
            if key.as_str() == *field {
                if *array {
                    output.push('[');
                }
                // Compact JSON escapes embedded newlines. Only the component
                // separators are literal newlines, including the final one.
                for (index, item) in encoded.split_terminator('\n').enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(item);
                }
                if *array {
                    output.push(']');
                }
            } else {
                butler_core::json::append_json(value, &mut output)?;
            }
        }
        output.push('}');
        Ok(output)
    }

    pub(super) fn attribute(
        mut self,
        attribution: Option<&butler_turn::btcc::UsageAttribution>,
        first_prompt: Option<&str>,
    ) -> Self {
        if let Some(attribution) = attribution {
            self.metadata["turnId"] = attribution.turn_id.clone().into();
            if let Some(Value::Object(fields)) = &attribution.prompt_diagnostics {
                for name in ["trigger", "instructionComponents"] {
                    if let Some(value) = fields.get(name) {
                        self.metadata[name] = value.clone();
                    }
                }
                let source = first_prompt
                    .filter(|prompt| fields.get("sourcePromptBytes") == Some(&json!(prompt.len())))
                    .and_then(|_| fields.get("inputSections"))
                    .and_then(Value::as_array);
                self.metadata["inputSections"] = layout_sections(
                    self.metadata["components"]
                        .as_array()
                        .map_or(&[][..], Vec::as_slice),
                    source,
                    self.source_index,
                );
            }
        }
        self
    }

    pub(super) async fn tokenize(
        mut self,
        catalog: Arc<crate::models::ModelCatalog>,
    ) -> Result<Self, ModelRoundError> {
        tokio::task::spawn_blocking(move || {
            let text =
                std::str::from_utf8(&self.prefix).map_err(|error| failure(error.to_string()))?;
            self.tokens = catalog
                .tokenizer
                .encode_ordinary(text)
                .map_err(|error| failure(error.to_string()))?
                .into();
            self.metadata["prefixTokens"] = self.tokens.len().into();
            self.metadata["tokenRepresentation"] =
                "serialized components using the catalog tokenizer".into();
            Ok(self)
        })
        .await
        .map_err(|error| failure(error.to_string()))?
    }
}

fn failure(message: String) -> ModelRoundError {
    ModelRoundError::InvocationFailure {
        code: Some("prefix_diagnostics_failed".into()),
        message,
    }
}

impl History {
    pub(super) fn prepare(
        &self,
        body: &Value,
        config: &ProviderRequestConfig,
    ) -> Result<Prepared, ModelRoundError> {
        prepare(body, config, &mut self.components.lock())
    }

    pub(super) fn observe(&self, scope: Option<&str>, mut current: Prepared) -> Value {
        // Unscoped calls cannot be attributed to the same session safely.
        let Some(scope) = scope else {
            return current.metadata;
        };
        let identity = hash(scope);
        let mut history = self.previous.lock();
        let now = Instant::now();
        if let Some(index) = history.iter().position(|(key, _, _, _)| *key == identity)
            && let Some((_, previous, previous_tokens, started)) = history.remove(index)
        {
            // Request-to-request gap; no timer or idle persistence is needed.
            current.metadata["idleGapMs"] =
                json!(now.duration_since(started).as_secs_f64() * 1000.0);
            let lcp = previous
                .iter()
                .zip(current.prefix.iter())
                .take_while(|(a, b)| a == b)
                .count();
            let token_lcp = previous_tokens
                .iter()
                .zip(current.tokens.iter())
                .take_while(|(a, b)| a == b)
                .count();
            current.metadata["previousPrefixTokens"] = previous_tokens.len().into();
            current.metadata["lcpTokens"] = token_lcp.into();
            current.metadata["lcpTokenPercent"] =
                json!(100.0 * token_lcp as f64 / previous_tokens.len().max(1) as f64);
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
        let current_bytes = current.prefix.len() + current.tokens.len() * 4;
        if current_bytes <= HISTORY_BYTES {
            let mut bytes = history
                .iter()
                .map(|(_, prefix, tokens, _)| prefix.len() + tokens.len() * 4)
                .sum::<usize>();
            while history.len() >= HISTORY_SESSIONS || bytes + current_bytes > HISTORY_BYTES {
                if let Some((_, evicted, evicted_tokens, _)) = history.pop_front() {
                    bytes -= evicted.len() + evicted_tokens.len() * 4;
                } else {
                    break;
                }
            }
            history.push_back((identity, current.prefix, current.tokens, now));
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

/// Keep missing provider fields distinct from a reported zero.
pub(super) fn reported_usage(prefix: &mut Value, response: &Value) {
    let cached_present = cached_tokens_present(response);
    prefix["providerReportedCachedTokens"] = if cached_present == false {
        Value::Null
    } else {
        cached_tokens(response)
    };
    prefix["providerCachedTokensFieldPresent"] = cached_present;
    prefix["providerReportedInputTokens"] = [
        "/usage/input_tokens",
        "/usage/prompt_tokens",
        "/usageMetadata/promptTokenCount",
    ]
    .into_iter()
    .find_map(|path| response.pointer(path).filter(|value| value.is_number()))
    .cloned()
    .unwrap_or(Value::Null);
    if (prefix["providerId"] == "anthropic" || response["type"] == "message")
        && let Some(input) = prefix["providerReportedInputTokens"].as_f64()
    {
        prefix["providerReportedInputTokens"] = json!(
            input
                + response
                    .pointer("/usage/cache_read_input_tokens")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                + response
                    .pointer("/usage/cache_creation_input_tokens")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
        );
    }
    prefix["providerReportedCacheWriteTokens"] =
        super::result::cache_write_tokens(response).map_or(Value::Null, |value| json!(value));
    prefix["providerReportedCacheWrite1hTokens"] =
        super::result::cache_write_1h_tokens(response).map_or(Value::Null, |value| json!(value));
    prefix["providerReportedCacheWrite5mTokens"] = response
        .pointer("/usage/cache_creation/ephemeral_5m_input_tokens")
        .filter(|value| value.is_number())
        .cloned()
        .unwrap_or(Value::Null);
    prefix["providerReportedOutputTokens"] = [
        "/usage/output_tokens",
        "/usage/completion_tokens",
        "/usageMetadata/candidatesTokenCount",
    ]
    .into_iter()
    .find_map(|path| response.pointer(path).filter(|value| value.is_number()))
    .cloned()
    .unwrap_or(Value::Null);
}

fn auth_route(mode: super::ProviderAuthMode) -> &'static str {
    use super::ProviderAuthMode;
    match mode {
        ProviderAuthMode::ApiKey => "api_key",
        ProviderAuthMode::CodexSubscription => "codex_subscription",
        ProviderAuthMode::CodexOauth => "oauth",
        ProviderAuthMode::None => "other",
    }
}

// Provider components are encoded JSON; source sections are exact UTF-8 text.
fn layout_sections(
    components: &[Value],
    source: Option<&Vec<Value>>,
    source_index: Option<usize>,
) -> Value {
    let mut sections = Vec::new();
    let absent = hash("null");
    for component in components {
        if component["sha256"] == absent {
            continue;
        }
        let name = component["component"].as_str().unwrap_or_default();
        if name == "input"
            && component["index"]
                .as_u64()
                .and_then(|index| usize::try_from(index).ok())
                == source_index
            && source.is_some()
        {
            sections.extend(source.into_iter().flatten().cloned());
        } else if matches!(
            name,
            "tools" | "instructions" | "system" | "systemInstruction" | "input"
        ) {
            let mut section = json!({"id":name, "index":component["index"],
                "bytes":component["bytes"], "representation":"serialized_json"});
            if let Some(hash) = component.get("sha256") {
                section["sha256"] = hash.clone();
            }
            sections.push(section);
        }
    }
    Value::Array(sections)
}

fn source_index(body: &Value) -> Option<usize> {
    ["input", "messages", "contents"]
        .into_iter()
        .find_map(|name| body.get(name).and_then(Value::as_array))?
        .iter()
        .position(|item| item["role"] == "user")
}
