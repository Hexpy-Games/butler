//! Source-compatible configuration mutations with owned temporary files.

mod local;

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::{ModelConfiguration, array, read_object_sync};
use crate::models::{
    CredentialView, LocalModelPlatform, LocalModelSource, ModelCatalogError, ProviderAuthMethod,
    RegisteredHostedModelConfig, normalize_registered_hosted_model,
};

#[derive(Clone)]
pub(crate) struct LocalModelMutation {
    pub server_url: String,
    pub api_key: Option<String>,
    pub platform: LocalModelPlatform,
    pub model_id: String,
    pub display_name: Option<String>,
    pub context_window_tokens: f64,
    pub max_output_tokens: Option<f64>,
    pub reasoning_budget_ratio: Option<f64>,
    pub source: LocalModelSource,
}

pub(crate) struct HostedModelMutation {
    pub provider_id: String,
    pub model_id: String,
    pub auth_type: ProviderAuthMethod,
    pub credential_id: Option<String>,
    pub api_key: Option<String>,
    pub credential_label: Option<String>,
    pub display_name: Option<String>,
    pub api_base_url: Option<String>,
    pub auth_profile: Option<String>,
}

pub(crate) struct ProviderCredentialMutation {
    pub provider_id: String,
    pub api_key: String,
    pub label: Option<String>,
    pub credential_id: Option<String>,
}

impl ModelConfiguration {
    pub(crate) async fn upsert_provider_credential(
        &self,
        input: &ProviderCredentialMutation,
        root: Option<&Path>,
    ) -> Result<CredentialView, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let path = root.join("auth/model-provider-credentials.json");
        super::credentials::upsert(
            &path,
            &input.provider_id,
            &input.api_key,
            input.label.as_deref(),
            input.credential_id.as_deref(),
            &self.registration_catalog,
            self.clock.as_ref(),
        )
    }

    pub(crate) async fn register_hosted_model(
        &self,
        input: &HostedModelMutation,
        root: Option<&Path>,
    ) -> Result<RegisteredHostedModelConfig, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        if input.auth_type == ProviderAuthMethod::CodexOauth && input.provider_id != "openai" {
            return Err(error(
                "Browser OAuth is only supported for OpenAI Codex auth.",
            ));
        }
        let requested = if input.model_id.contains('/') {
            input.model_id.clone()
        } else {
            format!("{}/{}", input.provider_id, input.model_id)
        };
        let available = self
            .registration_catalog
            .find_static_model_metadata(Some(&requested))
            .is_some_and(|model| model.provider_id == input.provider_id && model.runtime_supported);
        if !available {
            return Err(error("Provider model is not available for registration."));
        }
        let mut credential_id = input
            .credential_id
            .as_deref()
            .and_then(clean)
            .map(str::to_owned);
        if input.auth_type == ProviderAuthMethod::ApiKey {
            credential_id = Some(self.ensure_credential(input, root, credential_id)?);
        }
        let mut config = read_object_sync(&root.join("butler.config.json"));
        let now = self.clock.now_iso();
        let raw = json!({
            "provider_id":input.provider_id, "model_id":input.model_id,
            "auth_type":input.auth_type, "credential_id":credential_id,
            "display_name":input.display_name, "api_base_url":input.api_base_url,
            "auth_profile":input.auth_profile
        });
        let model = normalize_registered_hosted_model(&raw, &self.registration_catalog, &now)
            .ok_or_else(|| error("Provider model is not available for registration."))?;
        if input.api_base_url.as_deref().and_then(clean).is_some() && model.api_base_url.is_none() {
            return Err(error("Provider API base URL must be a valid http(s) URL."));
        }
        let mut current = normalized_registered(&config, self, &now);
        let created = current
            .iter()
            .find(|value| value.model_ref == model.model_ref)
            .map(|value| value.created_at.clone())
            .unwrap_or_else(|| model.created_at.clone());
        current.retain(|value| value.model_ref != model.model_ref);
        let mut model = model;
        model.created_at = created;
        current.push(model.clone());
        set_models_array(
            &mut config,
            "registered",
            serde_json::to_value(current).map_err(json_error)?,
        );
        write_json(&root.join("butler.config.json"), &config)?;
        Ok(model)
    }

    pub(crate) async fn delete_hosted_model(
        &self,
        lookup: &str,
        root: Option<&Path>,
    ) -> Result<RegisteredHostedModelConfig, ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let root = root.unwrap_or(&self.data_root);
        let mut config = read_object_sync(&root.join("butler.config.json"));
        let now = self.clock.now_iso();
        let mut current = normalized_registered(&config, self, &now);
        let lookup = crate::public_text::trim_js_whitespace(lookup);
        let previous = current
            .iter()
            .find(|value| value.model_ref == lookup || value.model_id == lookup)
            .cloned()
            .ok_or_else(|| error("Hosted model is not registered."))?;
        current.retain(|value| value.model_ref != previous.model_ref);
        set_models_array(
            &mut config,
            "registered",
            serde_json::to_value(current).map_err(json_error)?,
        );
        write_json(&root.join("butler.config.json"), &config)?;
        Ok(previous)
    }

    fn ensure_credential(
        &self,
        input: &HostedModelMutation,
        root: &Path,
        credential_id: Option<String>,
    ) -> Result<String, ModelCatalogError> {
        let path = root.join("auth/model-provider-credentials.json");
        let mut file = read_object_sync(&path);
        let mut records = array(file.get("credentials")).to_vec();
        if let Some(id) = credential_id {
            let valid = records.iter().any(|record| {
                record.get("id").and_then(Value::as_str).and_then(clean) == Some(id.as_str())
                    && record.get("provider_id").and_then(Value::as_str) == Some(&input.provider_id)
                    && record.get("auth_type").and_then(Value::as_str) == Some("api_key")
                    && record
                        .get("secret")
                        .and_then(Value::as_str)
                        .and_then(clean)
                        .is_some()
            });
            if valid {
                return Ok(id);
            }
            return Err(error("Provider API key credential is not registered."));
        }
        let secret = input
            .api_key
            .as_deref()
            .and_then(clean)
            .ok_or_else(|| error("Provider API key is required."))?;
        let id = format!("cred_{}", uuid::Uuid::new_v4());
        records.push(json!({
            "id":id, "provider_id":input.provider_id, "auth_type":"api_key",
            "label":input.credential_label.as_deref().and_then(clean).unwrap_or(&input.provider_id),
            "secret":secret, "created_at":self.clock.now_iso(), "updated_at":self.clock.now_iso()
        }));
        crate::json::object_mut(&mut file).insert("credentials".into(), Value::Array(records));
        write_json(&path, &file)?;
        Ok(id)
    }
}

fn normalized_registered(
    config: &Value,
    owner: &ModelConfiguration,
    now: &str,
) -> Vec<RegisteredHostedModelConfig> {
    let mut seen = std::collections::HashSet::new();
    array(config.pointer("/models/registered"))
        .iter()
        .filter_map(|value| {
            normalize_registered_hosted_model(value, &owner.registration_catalog, now)
        })
        .filter(|value| seen.insert(value.model_ref.clone()))
        .collect()
}

fn set_models_array(config: &mut Value, key: &str, value: Value) {
    let root = crate::json::object_mut(config);
    crate::json::object_field_mut(root, "models").insert(key.into(), value);
}

pub(super) fn write_json(path: &Path, value: &Value) -> Result<(), ModelCatalogError> {
    let parent = path
        .parent()
        .ok_or_else(|| error("Model configuration path is invalid."))?;
    std::fs::create_dir_all(parent).map_err(io_error)?;
    let temp = PathBuf::from(format!("{}.{}.tmp", path.display(), uuid::Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value).map_err(json_error)?;
    bytes.push(b'\n');
    if let Err(failure) = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, path)) {
        let _ = std::fs::remove_file(&temp);
        return Err(io_error(failure));
    }
    Ok(())
}

fn clean(value: &str) -> Option<&str> {
    let value = crate::public_text::trim_js_whitespace(value);
    (!value.is_empty()).then_some(value)
}
fn error(message: &'static str) -> ModelCatalogError {
    ModelCatalogError::rejected(message)
}
fn io_error(source: std::io::Error) -> ModelCatalogError {
    ModelCatalogError::Storage {
        message: "Model configuration could not be written.",
        source: source.into(),
    }
}
fn json_error(source: serde_json::Error) -> ModelCatalogError {
    ModelCatalogError::Storage {
        message: "Model configuration could not be serialized.",
        source: source.into(),
    }
}
