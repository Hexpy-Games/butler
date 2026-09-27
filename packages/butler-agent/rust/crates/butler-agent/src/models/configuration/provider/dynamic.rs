//! Request-local resolution of OpenAI's dynamic Codex carrier.

use std::cmp::Ordering;

use serde_json::Value;

use super::{
    ModelConfiguration, ModelConfigurationRead, ProviderAuth, ProviderRequestError, provider_error,
};
use crate::models::{ModelConfigurationEnvironment, ParsedModelRefSource, parse_model_ref};

pub(super) const AUTO_CODEX_LATEST: &str = "auto:codex-latest";
const DEFAULT_OPENAI_MODEL: &str = "gpt-5.5-codex";

pub(super) fn configured_model(
    environment: &ModelConfigurationEnvironment,
    config: &Value,
) -> String {
    if let Some(model) = environment
        .openai_model
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        return model.to_owned();
    }
    if let Some(model) = config
        .pointer("/system/openaiModel")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        return model.to_owned();
    }
    let legacy = config
        .pointer("/system/workerModel")
        .filter(|value| !value.is_null())
        .or_else(|| config.pointer("/system/defaultModel"));
    if let Some(model) = legacy
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
    {
        let parsed = parse_model_ref(model);
        return if parsed.source == ParsedModelRefSource::Namespaced {
            parsed.model_id
        } else {
            model.to_owned()
        };
    }
    DEFAULT_OPENAI_MODEL.to_owned()
}

pub(super) fn configured_reasoning(
    environment: &ModelConfigurationEnvironment,
    config: &Value,
) -> crate::models::ReasoningEffort {
    environment
        .openai_reasoning_effort
        .as_deref()
        .and_then(reasoning)
        .or_else(|| {
            config
                .pointer("/system/openaiReasoningEffort")
                .and_then(Value::as_str)
                .and_then(reasoning)
        })
        .unwrap_or(crate::models::ReasoningEffort::Medium)
}

fn reasoning(value: &str) -> Option<crate::models::ReasoningEffort> {
    use crate::models::ReasoningEffort;
    match value {
        "none" => Some(ReasoningEffort::None),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        "xhigh" => Some(ReasoningEffort::Xhigh),
        "max" => Some(ReasoningEffort::Max),
        _ => None,
    }
}

pub(super) async fn resolve(
    owner: &ModelConfiguration,
    root: &std::path::Path,
    read: &ModelConfigurationRead,
) -> Result<String, ProviderRequestError> {
    let auth = owner
        .resolve_auth(root, read, "openai", "", None)
        .await
        .map_err(|error| failure(error.message))?;
    let base = owner
        .environment
        .openai_base_url
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    let endpoint = if base.ends_with("/models") {
        base.to_owned()
    } else {
        format!("{base}/models")
    };
    let mut request = owner.client.get(endpoint);
    request = match &auth {
        ProviderAuth::ApiKey(key) => request.bearer_auth(key),
        ProviderAuth::Codex { authorization, .. } => request.header("authorization", authorization),
        ProviderAuth::None => request,
    };
    let response = request.send().await.map_err(failure)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(failure(format_args!(
            "OpenAI models API error ({status}): {body}"
        )));
    }
    let bytes = response.bytes().await.map_err(failure)?;
    let body: Value = serde_json::from_slice(&bytes).map_err(failure)?;
    let mut models: Vec<&str> = body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .filter(|id| !id.is_empty() && selectable(id))
        .collect();
    models.sort_by(|left, right| compare(owner, left, right));
    models
        .first()
        .map(|value| (*value).to_owned())
        .ok_or_else(|| {
            failure("No Codex-capable OpenAI model was returned by the configured model list.")
        })
}

fn compare(owner: &ModelConfiguration, left: &str, right: &str) -> Ordering {
    let left_score = score(left);
    let right_score = score(right);
    right_score
        .0
        .partial_cmp(&left_score.0)
        .unwrap_or(Ordering::Equal)
        .then_with(|| right_score.1.cmp(&left_score.1))
        .then_with(|| utf16_len(right).cmp(&utf16_len(left)))
        .then_with(|| owner.collation.compare(right, left))
}

fn score(model: &str) -> (f64, i32) {
    let lower = model.to_ascii_lowercase();
    let version = lower
        .strip_prefix("gpt-")
        .and_then(version_prefix)
        .map_or(0.0, |(version, _)| version);
    let tier = if lower.ends_with("-astra") {
        100
    } else if lower.ends_with("-sol") || plain_version(&lower) {
        90
    } else if lower.contains("-codex") {
        80
    } else if lower.ends_with("-terra") {
        60
    } else if lower.ends_with("-luna") {
        30
    } else {
        0
    };
    let max = if lower.contains("max") { 100 } else { 0 };
    let compact = if lower.contains("mini") || lower.contains("nano") {
        -10
    } else {
        0
    };
    (version, tier + max + compact)
}

fn selectable(model: &str) -> bool {
    let lower = model.to_ascii_lowercase();
    if lower == "gpt-5.6" {
        return true;
    }
    let Some(tail) = lower.strip_prefix("gpt-") else {
        return false;
    };
    let Some((_, end)) = version_prefix(tail) else {
        return false;
    };
    matches!(
        &tail[end..],
        suffix if suffix == "-codex" || suffix.starts_with("-codex-")
            || matches!(suffix, "-astra" | "-sol" | "-terra" | "-luna")
    )
}

fn plain_version(model: &str) -> bool {
    model
        .strip_prefix("gpt-")
        .and_then(version_prefix)
        .is_some_and(|(_, end)| end == model.len() - "gpt-".len())
}

fn version_prefix(value: &str) -> Option<(f64, usize)> {
    let bytes = value.as_bytes();
    let integer_end = bytes
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .unwrap_or(bytes.len());
    if integer_end == 0 {
        return None;
    }
    let end = if bytes.get(integer_end) == Some(&b'.') {
        let decimal_end = bytes[integer_end + 1..]
            .iter()
            .position(|byte| !byte.is_ascii_digit())
            .map_or(bytes.len(), |offset| integer_end + 1 + offset);
        if decimal_end == integer_end + 1 {
            integer_end
        } else {
            decimal_end
        }
    } else {
        integer_end
    };
    value[..end].parse().ok().map(|version| (version, end))
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn failure(reason: impl std::fmt::Display) -> ProviderRequestError {
    let reason = reason.to_string();
    let mut error = provider_error(
        "provider_unknown_error",
        "models",
        "Configured OpenAI dynamic model could not be resolved.",
    );
    error.message = format!(
        "Configured OpenAI model {AUTO_CODEX_LATEST} could not be resolved from provider model discovery: {reason}"
    );
    error.cause = Some(reason);
    error
}
