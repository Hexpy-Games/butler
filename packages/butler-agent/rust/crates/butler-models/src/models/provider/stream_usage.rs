//! Session-scoped compatibility for Chat servers rejecting usage options.
use std::collections::HashSet;

use butler_turn::btcc::ProviderRequestError;
use parking_lot::Mutex;

use super::{ProviderRequestConfig, serialize::Carrier};

#[derive(Default)]
pub(super) struct StreamUsage {
    refused: Mutex<HashSet<(String, String)>>,
}

impl StreamUsage {
    pub(super) fn supported(&self, config: &ProviderRequestConfig) -> bool {
        !self.refused.lock().contains(&key(config))
    }

    pub(super) fn refuse(&self, config: &ProviderRequestConfig) {
        self.refused.lock().insert(key(config));
    }
}

fn key(config: &ProviderRequestConfig) -> (String, String) {
    (
        config.metadata.provider_id.clone(),
        config.endpoint.to_string(),
    )
}

/// Retry only an explicit HTTP rejection of the optional Chat field, once.
pub(super) fn rejected(carrier: Carrier, error: &ProviderRequestError) -> bool {
    matches!(carrier, Carrier::Chat { stream: true })
        && error.status_code == Some(400)
        && (error
            .cause
            .as_deref()
            .is_some_and(|cause| cause.contains("stream_options"))
            || error
                .provider_error_details
                .as_deref()
                .and_then(|details| details.get("param"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|param| {
                    matches!(param, "stream_options" | "stream_options.include_usage")
                }))
}

/// Preserve usage accounting when a compatible server omits usage chunks.
/// Input uses the already-tokenized request; output uses the catalog's
/// character estimate and includes every returned tool argument and text.
pub(super) fn estimate(
    result: &butler_turn::btcc::ModelRoundResult,
    prefix: &serde_json::Value,
    model: &str,
) -> Option<serde_json::Value> {
    let prompt = prefix["prefixTokens"].as_f64()?;
    let text = result
        .text
        .as_deref()
        .unwrap_or_default()
        .encode_utf16()
        .count();
    let arguments: usize = result
        .tool_calls
        .iter()
        .map(|call| call.raw_arguments.encode_utf16().count())
        .sum();
    let output = ((text + arguments) as f64 / 3.8).ceil();
    Some(
        serde_json::json!({"model":model,"promptTokens":prompt,"cachedTokens":0,
        "outputTokens":output,"totalTokens":prompt + output,"source":"estimate"}),
    )
}
