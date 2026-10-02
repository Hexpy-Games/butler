//! Default selection shared by native turns, App setup, MCP and sizing.
use super::{ModelPreset, ReasoningEffort, StaticCatalog};
use crate::models::{ModelCatalog, ModelCatalogError};
use serde_json::Value;

pub const DEFAULT_PROVIDER: &str = "openai";
/// Preserves the recorded policy of installations predating routine presets.
pub const LEGACY_DEFAULT_MODEL: &str = "openai/gpt-5.5";

impl StaticCatalog {
    pub(super) fn default_preset(&self, provider: Option<&str>) -> ModelPreset {
        self.routine_preset(provider.unwrap_or(DEFAULT_PROVIDER))
            .cloned()
            .unwrap_or_else(|| ModelPreset {
                model: String::new(),
                effort: ReasoningEffort::Medium,
            })
    }
}

impl ModelCatalog {
    /// Registered providers retain their configuration order, as in App setup.
    /// A credential-only connection is also eligible before model registration.
    pub fn default_preset(&self, config: &Value, credentials: &Value) -> ModelPreset {
        let first = config
            .pointer("/models/registered")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|entry| self.connected_registration(entry))
            .or_else(|| {
                config
                    .pointer("/models/local")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|entry| {
                        entry
                            .get("model_id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty())
                    })
            });
        let provider = first
            .and_then(|entry| entry.get("provider_id"))
            .and_then(Value::as_str)
            .or_else(|| first.map(|_| "local"))
            .or_else(|| {
                credentials
                    .get("credentials")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.get("provider_id").and_then(Value::as_str))
                    .find(|provider| self.static_catalog.routine_preset(provider).is_some())
            });
        let mut preset = self.static_catalog.default_preset(provider);
        // Local/custom providers have no routine preset: use their connected model.
        if preset.model.is_empty()
            && let Some(first) = first
        {
            preset.model = first
                .get("model_ref")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "{}/{}",
                        provider.unwrap_or_default(),
                        first
                            .get("model_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    )
                });
        }
        preset
    }

    fn connected_registration(&self, entry: &Value) -> bool {
        if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
            return false;
        }
        let Some(provider) = entry.get("provider_id").and_then(Value::as_str) else {
            return false;
        };
        let Some(id) = entry
            .get("model_id")
            .filter(|value| !value.is_null())
            .or_else(|| entry.get("model_ref"))
            .and_then(Value::as_str)
        else {
            return false;
        };
        let requested = if id.contains('/') {
            id.to_owned()
        } else {
            format!("{provider}/{id}")
        };
        super::lookup::find_model_metadata(Some(&requested), &self.static_catalog.models)
            .is_some_and(|model| model.runtime_supported && model.provider_id == provider)
    }

    pub fn model_refs(&self) -> Vec<String> {
        self.static_catalog
            .models
            .iter()
            .filter(|model| model.runtime_supported)
            .map(|model| model.model_ref.clone())
            .collect()
    }
}

/// Startup-only filesystem projection; no credential store or network access.
pub fn default_model_at(root: &std::path::Path) -> Result<String, ModelCatalogError> {
    let read = |name: &str| {
        std::fs::read(root.join(name))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_default()
    };
    let config = read("butler.config.json");
    let configured = configured_default_model(&config);
    let model = configured.map(str::to_owned).unwrap_or(
        ModelCatalog::new()?
            .default_preset(&config, &read("auth/model-provider-credentials.json"))
            .model,
    );
    Ok(super::parse_model_ref(&model).canonical_ref)
}

/// One saved-choice reader: ignore blank fields before applying precedence.
pub fn configured_default_model(config: &Value) -> Option<&str> {
    ["/system/butlerModel", "/system/defaultModel"]
        .into_iter()
        .filter_map(|key| config.pointer(key).and_then(Value::as_str))
        .map(butler_core::public_text::trim_js_whitespace)
        .find(|value| !value.is_empty())
}
