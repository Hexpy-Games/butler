//! Read and write the two model fields exposed by the retained MCP tools.

use serde_json::Value;

use super::ModelConfiguration;
use crate::models::{ModelCatalogError, ParsedModelRef, parse_model_ref};

use crate::models::DEFAULT_RUNTIME_MODEL_REF as DEFAULT_MODEL;
const VALID_MODELS: &[&str] = &[
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5-codex",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "auto:codex-latest",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpModelTarget {
    Worker,
    Butler,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpModelDetails {
    pub raw: String,
    pub provider_id: String,
    pub model_id: String,
    pub canonical_ref: String,
}

impl ModelConfiguration {
    pub fn mcp_model_details(&self, target: McpModelTarget) -> McpModelDetails {
        let config = super::read_object_sync(&self.data_root.join("butler.config.json"));
        details(&config, target)
    }

    pub async fn set_mcp_model(
        &self,
        target: McpModelTarget,
        requested: &str,
    ) -> Result<(), ModelCatalogError> {
        let trimmed = butler_core::public_text::trim_js_whitespace(requested);
        if !valid_model(trimmed) {
            let label = match target {
                McpModelTarget::Worker => "worker",
                McpModelTarget::Butler => "butler",
            };
            return Err(ModelCatalogError::rejected(format!(
                "Invalid {label} model: \"{requested}\". Valid: {}",
                VALID_MODELS.join(", ")
            )));
        }

        let _write = self.configuration_writes.acquire().await;
        let path = self.data_root.join("butler.config.json");
        let _change = super::mutations::lock_config(&self.data_root).await?;
        let mut config = super::read_object_sync(&path);
        let canonical = parse_model_ref(trimmed).canonical_ref;
        let system = butler_core::json::object_field_mut(
            butler_core::json::object_mut(&mut config),
            "system",
        );
        let field = match target {
            McpModelTarget::Worker => "workerModel",
            McpModelTarget::Butler => "butlerModel",
        };
        system.insert(field.into(), Value::String(canonical));
        super::mutations::write_json(&path, &config)
    }
}

fn details(config: &Value, target: McpModelTarget) -> McpModelDetails {
    let system = config.pointer("/system");
    let candidate = match target {
        McpModelTarget::Worker => system.and_then(|value| value.get("workerModel")),
        McpModelTarget::Butler => system
            .and_then(|value| value.get("butlerModel"))
            .filter(|value| value.as_str().is_some_and(valid_config_value))
            .or_else(|| system.and_then(|value| value.get("defaultModel"))),
    };
    let raw = candidate
        .and_then(Value::as_str)
        .filter(|value| valid_config_value(value))
        .unwrap_or(DEFAULT_MODEL)
        .to_owned();
    details_from_raw(raw)
}

fn details_from_raw(raw: String) -> McpModelDetails {
    let ParsedModelRef {
        canonical_ref,
        provider_id,
        model_id,
        ..
    } = parse_model_ref(&raw);
    McpModelDetails {
        raw,
        provider_id,
        model_id,
        canonical_ref,
    }
}

fn valid_config_value(value: &str) -> bool {
    VALID_MODELS.contains(&value) || is_namespaced_ref(value)
}

fn is_namespaced_ref(value: &str) -> bool {
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !provider.chars().any(char::is_whitespace)
        && model
            .chars()
            .next()
            .is_some_and(|first| first != '/' && !first.is_whitespace())
}

fn valid_model(value: &str) -> bool {
    if VALID_MODELS.contains(&value) {
        return true;
    }
    if is_namespaced_ref(value) {
        return true;
    }
    value == "auto:codex-latest"
        || (value
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("gpt-5"))
            && value[5..]
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-".contains(character)))
        || value.get(..2).is_some_and(|prefix| {
            prefix.eq_ignore_ascii_case("o1")
                || prefix.eq_ignore_ascii_case("o2")
                || prefix.eq_ignore_ascii_case("o3")
                || prefix.eq_ignore_ascii_case("o4")
                || prefix.eq_ignore_ascii_case("o5")
                || prefix.eq_ignore_ascii_case("o6")
                || prefix.eq_ignore_ascii_case("o7")
                || prefix.eq_ignore_ascii_case("o8")
                || prefix.eq_ignore_ascii_case("o9")
        })
}

#[cfg(test)]
mod tests {
    use super::{McpModelTarget, details, valid_model};
    use serde_json::json;

    // test-category: pure-logic
    #[test]
    fn mcp_model_targets_accept_supported_refs_and_fall_back_from_unsupported_ids() {
        // reads worker and butler with source fallbacks
        {
            let config = json!({
                "system": { "workerModel": "gpt-5.4", "defaultModel": "anthropic/claude" }
            });
            assert_eq!(details(&config, McpModelTarget::Worker).raw, "gpt-5.4");
            assert_eq!(
                details(&config, McpModelTarget::Butler).canonical_ref,
                "anthropic/claude"
            );
            assert_eq!(
                details(&json!({}), McpModelTarget::Worker).raw,
                "openai/gpt-6.1-sol"
            );
        }
        // config reads reject raw ids and apply source fallbacks
        {
            let config = json!({
                "system": {
                    "workerModel": "gpt-5.9",
                    "butlerModel": "o3-pro",
                    "defaultModel": "gpt-5.8"
                }
            });
            assert_eq!(
                details(&config, McpModelTarget::Worker).raw,
                "openai/gpt-6.1-sol"
            );
            assert_eq!(
                details(&config, McpModelTarget::Butler).raw,
                "openai/gpt-6.1-sol"
            );
        }
        // accepts source aliases namespaced refs and supported raw ids
        {
            assert!(valid_model("gpt-6-astra"));
            assert!(valid_model("gpt-6.1-sol"));
            assert!(valid_model("gpt-6-sol"));
            assert!(valid_model("gpt-6-luna"));
            assert!(valid_model("anthropic/claude-sonnet-5"));
            assert!(valid_model("GPT-5.9-preview"));
            assert!(valid_model("o3-pro"));
            assert!(!valid_model("gpt-4.1"));
            assert!(!valid_model("/model"));
        }
    }
}
