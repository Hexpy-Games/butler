//! Read and write the two model fields exposed by the retained MCP tools.

use serde_json::{Value, json};

use super::ModelConfiguration;
use crate::models::{ModelCatalogError, ParsedModelRef, parse_model_ref};

const DEFAULT_MODEL: &str = "openai/gpt-5.5-codex";
const VALID_MODELS: &[&str] = &[
    "gpt-6-astra",
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
pub(crate) enum McpModelTarget {
    Worker,
    Butler,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpModelDetails {
    pub(crate) raw: String,
    pub(crate) provider_id: String,
    pub(crate) model_id: String,
    pub(crate) canonical_ref: String,
}

impl ModelConfiguration {
    pub(crate) fn mcp_model_details(&self, target: McpModelTarget) -> McpModelDetails {
        let config = super::read_object_sync(&self.data_root.join("butler.config.json"));
        details(&config, target)
    }

    pub(crate) async fn set_mcp_model(
        &self,
        target: McpModelTarget,
        requested: &str,
    ) -> Result<(), ModelCatalogError> {
        let trimmed = crate::public_text::trim_js_whitespace(requested);
        if !valid_model(trimmed) {
            let label = match target {
                McpModelTarget::Worker => "worker",
                McpModelTarget::Butler => "butler",
            };
            return Err(ModelCatalogError::new(format!(
                "Invalid {label} model: \"{requested}\". Valid: {}",
                VALID_MODELS.join(", ")
            )));
        }

        let _write = self.configuration_writes.acquire().await;
        let path = self.data_root.join("butler.config.json");
        let mut config = super::read_object_sync(&path);
        let canonical = parse_model_ref(trimmed).canonical_ref;
        let system = config
            .as_object_mut()
            .expect("configuration reader returns an object")
            .entry("system")
            .or_insert_with(|| json!({}));
        if !system.is_object() {
            *system = json!({});
        }
        let field = match target {
            McpModelTarget::Worker => "workerModel",
            McpModelTarget::Butler => "butlerModel",
        };
        system
            .as_object_mut()
            .expect("system configuration is an object")
            .insert(field.into(), Value::String(canonical));
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

    #[test]
    fn reads_worker_and_butler_with_source_fallbacks() {
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
            "openai/gpt-5.5-codex"
        );
    }

    #[test]
    fn config_reads_reject_raw_ids_and_apply_source_fallbacks() {
        let config = json!({
            "system": {
                "workerModel": "gpt-5.9",
                "butlerModel": "o3-pro",
                "defaultModel": "gpt-5.8"
            }
        });
        assert_eq!(
            details(&config, McpModelTarget::Worker).raw,
            "openai/gpt-5.5-codex"
        );
        assert_eq!(
            details(&config, McpModelTarget::Butler).raw,
            "openai/gpt-5.5-codex"
        );
    }

    #[test]
    fn accepts_source_aliases_namespaced_refs_and_supported_raw_ids() {
        assert!(valid_model("gpt-6-astra"));
        assert!(valid_model("gpt-6-sol"));
        assert!(valid_model("gpt-6-luna"));
        assert!(valid_model("anthropic/claude-sonnet-5"));
        assert!(valid_model("GPT-5.9-preview"));
        assert!(valid_model("o3-pro"));
        assert!(!valid_model("gpt-4.1"));
        assert!(!valid_model("/model"));
    }
}
