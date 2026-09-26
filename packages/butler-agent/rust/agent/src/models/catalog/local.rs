use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use super::{ModelProviderMetadata, ReasoningEffort, TokenEstimatorKind};

const LOCAL_SOURCE: &str =
    "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LocalModelPlatform {
    LlamaCpp,
    Ollama,
    LmStudio,
    Custom,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LocalModelSource {
    Discovered,
    Manual,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct LocalModelConfig {
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub model_ref: String,
    pub display_name: String,
    pub api_type: String,
    pub platform: LocalModelPlatform,
    pub server_url: String,
    pub api_base_url: String,
    pub context_window_tokens: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_budget_ratio: Option<f64>,
    pub token_estimator: TokenEstimatorKind,
    pub source: LocalModelSource,
    pub source_url: String,
    pub runtime_supported: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

pub(crate) fn normalize_local_model_config(value: &Value, now: &str) -> Option<LocalModelConfig> {
    let input = value.as_object()?;
    let model_id = crate::public_text::trim_js_whitespace(input.get("model_id")?.as_str()?);
    if model_id.is_empty() {
        return None;
    }
    let context = positive_integer(input.get("context_window_tokens")?)?;
    let (server_url, api_base_url) =
        normalize_local_server_url(input.get("server_url")?.as_str()?)?;
    let api_base_url = input
        .get("api_base_url")
        .and_then(Value::as_str)
        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
        .and_then(normalize_local_server_url)
        .map(|(_, api_base_url)| api_base_url)
        .unwrap_or(api_base_url);
    let display_name = input
        .get("display_name")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| display_name_for_id(model_id));
    let ratio = input
        .get("reasoning_budget_ratio")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .filter(|value| *value > 0.0)
        .map(|value| (value * 10_000.0).round() / 10_000.0);
    Some(LocalModelConfig {
        provider_id: "local".into(),
        provider_label: "Custom".into(),
        model_ref: input
            .get("model_ref")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("local/"))
            .map(str::to_owned)
            .unwrap_or_else(|| format!("local/{}", safe_local_model_id(model_id))),
        model_id: model_id.to_owned(),
        display_name,
        api_type: "openai_compatible".into(),
        platform: platform(input.get("platform")),
        server_url,
        api_base_url,
        context_window_tokens: context,
        max_output_tokens: input.get("max_output_tokens").and_then(positive_integer),
        reasoning_budget_ratio: ratio,
        token_estimator: TokenEstimatorKind::CharacterEstimate,
        source: if input.get("source").and_then(Value::as_str) == Some("manual") {
            LocalModelSource::Manual
        } else {
            LocalModelSource::Discovered
        },
        source_url: input
            .get("source_url")
            .and_then(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .filter(|v| !v.is_empty())
            .unwrap_or(LOCAL_SOURCE)
            .into(),
        runtime_supported: true,
        created_at: input
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or(now)
            .into(),
        updated_at: input
            .get("updated_at")
            .and_then(Value::as_str)
            .unwrap_or(now)
            .into(),
        extensions: Map::new(),
    })
}

impl From<&LocalModelConfig> for ModelProviderMetadata {
    fn from(model: &LocalModelConfig) -> Self {
        let native = local_native_reasoning(&model.model_id);
        let budget = native
            .is_none()
            .then(|| {
                model.reasoning_budget_ratio.and_then(|ratio| {
                    let max = model.max_output_tokens?;
                    let value = (max * ratio.min(1.0)).round();
                    (value > 0.0).then_some(value)
                })
            })
            .flatten();
        let efforts = native.unwrap_or_else(|| {
            if budget.is_some() {
                vec![ReasoningEffort::None, ReasoningEffort::High]
            } else {
                vec![ReasoningEffort::None]
            }
        });
        let mut budgets = Map::new();
        if let Some(value) = budget {
            budgets.insert("high".into(), Value::from(value));
        }
        ModelProviderMetadata {
            provider_id: "local".into(),
            provider_label: model.provider_label.clone(),
            provider_family_id: None,
            model_id: model.model_id.clone(),
            model_ref: model.model_ref.clone(),
            aliases: None,
            display_name: model.display_name.clone(),
            status: "available".into(),
            context_window_tokens: Some(model.context_window_tokens),
            max_output_tokens: model.max_output_tokens,
            default_reasoning_effort: if local_native_reasoning(&model.model_id).is_some() {
                ReasoningEffort::Xhigh
            } else if budget.is_some() {
                ReasoningEffort::High
            } else {
                ReasoningEffort::None
            },
            reasoning_efforts: efforts,
            reasoning_budget_tokens: (!budgets.is_empty()).then_some(budgets),
            token_estimator: model.token_estimator,
            source_url: model.source_url.clone(),
            runtime_supported: true,
            hosted_api_shape: None,
            api_base_url: None,
            api_type: Some(model.api_type.clone()),
            platform: Some(model.platform),
            server_url: Some(model.server_url.clone()),
            source: Some(model.source),
            local_reasoning_budget_ratio: local_native_reasoning(&model.model_id)
                .is_none()
                .then_some(model.reasoning_budget_ratio)
                .flatten(),
            registered: None,
            enabled: None,
            auth_type: None,
            credential_id: None,
            credential_label: None,
            credential_masked_value: None,
            image_input_support: None,
            image_capability_source: None,
            image_route_health: None,
            image_input_modalities: None,
            image_accepted_mime_types: None,
            image_max_inline_bytes: None,
            image_max_width: None,
            image_max_height: None,
            image_max_pixels: None,
            image_capability_source_url: None,
            image_capability_verified_at: None,
            image_capability_revision: None,
            image_capability_digest: None,
            image_endpoint_profile_id: None,
            image_carrier_protocol: None,
            image_tool_server_id: None,
            image_tool_name: None,
            image_tool_capability_digest: None,
            extensions: Map::new(),
        }
    }
}

fn local_native_reasoning(model_id: &str) -> Option<Vec<ReasoningEffort>> {
    let lower = model_id.to_lowercase();
    let position = lower.find("qwen3.8")?;
    let before = position == 0 || lower.as_bytes().get(position.wrapping_sub(1)) == Some(&b'/');
    let end = position + 7;
    let after = end == lower.len() || matches!(lower.as_bytes().get(end), Some(b'-' | b':'));
    (before && after).then(|| {
        vec![
            ReasoningEffort::None,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::Xhigh,
        ]
    })
}

fn platform(value: Option<&Value>) -> LocalModelPlatform {
    match value.and_then(Value::as_str) {
        Some("llama_cpp") => LocalModelPlatform::LlamaCpp,
        Some("ollama") => LocalModelPlatform::Ollama,
        Some("lm_studio") => LocalModelPlatform::LmStudio,
        _ => LocalModelPlatform::Custom,
    }
}
fn positive_integer(value: &Value) -> Option<f64> {
    let value = value.as_f64()?;
    (value.is_finite() && value.trunc() > 0.0).then_some(value.trunc())
}
fn safe_local_model_id(value: &str) -> String {
    let value = crate::public_text::trim_js_whitespace(value);
    let trimmed = value.strip_prefix("local/").unwrap_or(value);
    let filtered = trimmed
        .chars()
        .filter(|ch| (*ch as u32) >= 32 && (*ch as u32) != 127)
        .collect::<String>()
        .replace(['/', '\\'], "-");
    let mut output = String::new();
    let mut gap = false;
    for ch in filtered.chars() {
        if js_whitespace(ch) {
            gap = true;
        } else {
            if gap && !output.is_empty() {
                output.push('-');
            }
            gap = false;
            output.push(ch);
        }
    }
    let output = output.trim_matches('/');
    if output.is_empty() {
        "local-model".into()
    } else {
        output.into()
    }
}

fn js_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' |
        '\u{3000}' | '\u{feff}')
}
fn display_name_for_id(id: &str) -> String {
    let lower = id.to_lowercase();
    let base = [".gguf", ".bin", ".safetensors"]
        .iter()
        .find_map(|suffix| {
            lower
                .ends_with(suffix)
                .then(|| &id[..id.len() - suffix.len()])
        })
        .unwrap_or(id);
    let result = base.replace(['-', '_'], " ");
    let result = crate::public_text::trim_js_whitespace(&result);
    if result.is_empty() {
        id.into()
    } else {
        result.into()
    }
}

fn normalize_local_server_url(value: &str) -> Option<(String, String)> {
    let text = crate::public_text::trim_js_whitespace(value);
    if text.is_empty() {
        return None;
    }
    let has_scheme = text.split_once("://").is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme.as_bytes()[0].is_ascii_alphabetic()
            && scheme
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
    });
    let value = if has_scheme {
        text.to_owned()
    } else {
        format!("http://{text}")
    };
    let mut url = Url::parse(&value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    url.set_query(None);
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    let server = url.as_str().trim_end_matches('/').to_owned();
    let api = if url.path().trim_matches('/').is_empty() {
        format!("{server}/v1")
    } else {
        server.clone()
    };
    Some((server, api))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_model_normalization_keeps_raw_id_and_saved_endpoint_reference() {
        let model = normalize_local_model_config(
            &serde_json::json!({
                "model_id":" org/model ",
                "model_ref":"local/custom-reference",
                "server_url":"https://models.example/legacy",
                "api_base_url":"https://models.example/legacy/v1",
                "context_window_tokens":8192
            }),
            "now",
        )
        .unwrap();
        assert_eq!(model.model_id, "org/model");
        assert_eq!(model.model_ref, "local/custom-reference");
        assert_eq!(model.api_base_url, "https://models.example/legacy/v1");
        assert_eq!(model.provider_label, "Custom");
    }
}
