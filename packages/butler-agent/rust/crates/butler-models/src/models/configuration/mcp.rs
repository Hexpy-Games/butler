//! Read and write the two model fields exposed by the retained MCP tools.

use serde_json::Value;

use super::ModelConfiguration;
use crate::models::{ModelCatalogError, ParsedModelRef, parse_model_ref};

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
        let snapshot = self.sizing_catalog(&self.data_root);
        let catalog = snapshot.as_ref().unwrap_or(&self.registration_catalog);
        details(
            &config,
            target,
            &self.default_model_from(&self.data_root).model,
            catalog,
        )
    }

    pub async fn set_mcp_model(
        &self,
        target: McpModelTarget,
        requested: &str,
    ) -> Result<(), ModelCatalogError> {
        let trimmed = butler_core::public_text::trim_js_whitespace(requested);
        let catalog = self.read().await?.catalog;
        if !valid_model(trimmed, &catalog) {
            let label = match target {
                McpModelTarget::Worker => "worker",
                McpModelTarget::Butler => "butler",
            };
            return Err(ModelCatalogError::rejected(format!(
                "Invalid {label} model: \"{requested}\". Valid: {}",
                catalog
                    .view()
                    .models
                    .iter()
                    .filter(|model| model.runtime_supported)
                    .map(|model| model.model_ref.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }

        let _write = self.configuration_writes.acquire().await;
        let path = self.data_root.join("butler.config.json");
        let _change = super::mutations::lock_config(&self.data_root).await?;
        let mut config = super::read_object_sync(&path);
        let canonical = if trimmed == "auto:codex-latest" {
            format!("openai/{trimmed}")
        } else {
            parse_model_ref(trimmed).canonical_ref
        };
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

fn details(
    config: &Value,
    target: McpModelTarget,
    default: &str,
    catalog: &crate::models::ModelCatalogSnapshot,
) -> McpModelDetails {
    let system = config.pointer("/system");
    let candidate = match target {
        McpModelTarget::Worker => system.and_then(|value| value.get("workerModel")),
        McpModelTarget::Butler => system
            .and_then(|value| value.get("butlerModel"))
            .filter(|value| {
                value
                    .as_str()
                    .is_some_and(|value| valid_model(value, catalog))
            })
            .or_else(|| system.and_then(|value| value.get("defaultModel"))),
    };
    let raw = candidate
        .and_then(Value::as_str)
        .filter(|value| valid_model(value, catalog))
        .unwrap_or(default)
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

fn valid_model(value: &str, catalog: &crate::models::ModelCatalogSnapshot) -> bool {
    value == "auto:codex-latest"
        || value == "openai/auto:codex-latest"
        || catalog
            .find_model_metadata(Some(value))
            .is_some_and(|model| model.runtime_supported)
        || catalog.view().registered_models.iter().any(|model| {
            model.runtime_supported
                && model.enabled != Some(false)
                && (model.model_ref == value || model.model_id == value)
        })
}

#[cfg(test)]
mod tests {
    use super::{McpModelTarget, details, valid_model};
    use crate::models::{ModelCatalog, ModelCatalogSnapshotInput};
    use butler_core::locale::LocaleCollation;
    use serde_json::json;
    // test-category: pure-logic
    #[test]
    fn mcp_model_targets_accept_supported_refs_and_fall_back_from_unsupported_ids() {
        let catalog = ModelCatalog::new().unwrap();
        let locale = LocaleCollation::new("en").unwrap();
        let snapshot = catalog
            .snapshot(
                ModelCatalogSnapshotInput {
                    configured_local: vec![],
                    extra_models: vec![],
                    registered_models: vec![],
                    credential_views: vec![],
                    default_model_ref: None,
                    generated_at: String::new(),
                },
                &locale,
            )
            .unwrap();
        let default = &snapshot.view().default_model_ref;
        assert_eq!(
            details(&json!({}), McpModelTarget::Worker, default, &snapshot).raw,
            *default
        );
        let config = json!({"system":{"workerModel":"gpt-5.9", "butlerModel":"o3-pro", "defaultModel":"gpt-5.8"}});
        assert_eq!(
            details(&config, McpModelTarget::Worker, default, &snapshot).raw,
            *default
        );
        assert_eq!(
            details(&config, McpModelTarget::Butler, default, &snapshot).raw,
            *default
        );
        for model in [
            "gpt-6-astra",
            "gpt-6.1-sol",
            "gpt-6-sol",
            "gpt-6-luna",
            "anthropic/claude-sonnet-5",
            "auto:codex-latest",
        ] {
            assert!(valid_model(model, &snapshot), "{model}");
        }
        for model in [
            "GPT-5.9-preview",
            "o3-pro",
            "gpt-4.1",
            "/model",
            "anthropic/nonexistent",
        ] {
            assert!(!valid_model(model, &snapshot), "{model}");
        }
    }
}
