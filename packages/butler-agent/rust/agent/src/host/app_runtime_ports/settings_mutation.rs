//! App preference side effects through the existing Profile and Models owners.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::{
    gateway::{AppSettingsMutationPort, ApplicationFuture, GatewayApplicationError},
    host::ResolvedInstallation,
    models::ModelConfiguration,
    profile::ProfileService,
};

pub(crate) struct NativeAppSettingsMutation {
    configuration: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    installation: ResolvedInstallation,
    data_root: PathBuf,
}

impl NativeAppSettingsMutation {
    pub(crate) fn new(
        configuration: Arc<ModelConfiguration>,
        profile: Arc<ProfileService>,
        installation: ResolvedInstallation,
        data_root: PathBuf,
    ) -> Self {
        Self {
            configuration,
            profile,
            installation,
            data_root,
        }
    }

    async fn apply_inner(
        &self,
        patch: Value,
        projection: Value,
    ) -> Result<(), GatewayApplicationError> {
        let patch = patch.as_object().cloned().unwrap_or_default();
        let web_patch = patch.get("web_search").and_then(Value::as_object);
        let provider = projection
            .pointer("/web_search/provider")
            .and_then(Value::as_str)
            .unwrap_or("duckduckgo-html");
        let api_key = web_patch
            .and_then(|value| value.get("api_key"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let environment_key = api_key.and_then(|_| environment_key(provider));

        let mut destinations = Vec::new();
        let writes_config = patch.contains_key("consolidation_model")
            || patch.contains_key("consolidation_reasoning_effort")
            || patch.contains_key("web_search")
            || patch.contains_key("language")
            || patch.contains_key("timezone")
            || patch.contains_key("model_fallback")
            || patch.contains_key("model");
        if writes_config {
            destinations.push("butler.config.json");
        }
        if environment_key.is_some() {
            destinations.push(".env");
        }
        let root = self.validated_root(&destinations)?;

        if let Some(model) = patch.get("consolidation_model").and_then(Value::as_str) {
            self.profile
                .set_extractor_model(Some(model.to_owned()))
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
        }
        if let Some(effort) = patch
            .get("consolidation_reasoning_effort")
            .and_then(Value::as_str)
        {
            self.profile
                .set_extractor_reasoning_effort(Some(effort.to_owned()))
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
        }
        if let (Some(key), Some(value)) = (environment_key, api_key) {
            self.configuration
                .upsert_private_environment_value(key, value, &root)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
        }
        if patch.contains_key("web_search") {
            let web_search = projection.get("web_search").unwrap_or(&Value::Null);
            let config_patch = json!({
                "provider": web_search.get("provider"),
                "readerBackend": web_search.get("reader_backend"),
                "planning": {
                    "enabled": web_search.get("planning_enabled"),
                    "defaultDepth": web_search.get("planning_default_depth"),
                }
            });
            self.configuration
                .update_web_search_settings(&config_patch, &root)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
        }

        let mut user_patch = Map::new();
        if let Some(value) = patch.get("language") {
            user_patch.insert("language".into(), value.clone());
        }
        if let Some(value) = patch.get("timezone") {
            user_patch.insert("timezone".into(), value.clone());
        }
        if (patch.contains_key("model_fallback") || patch.contains_key("model"))
            && let Some(value) = projection.get("model_fallback")
        {
            user_patch.insert("modelFallback".into(), value.clone());
        }
        if !user_patch.is_empty() {
            self.configuration
                .update_user_settings(&Value::Object(user_patch), Some(&root))
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
        }
        Ok(())
    }

    fn validated_root(&self, destinations: &[&str]) -> Result<PathBuf, GatewayApplicationError> {
        if destinations.is_empty() {
            return Ok(self.data_root.clone());
        }
        let root = self
            .installation
            .validate_data_root(&self.data_root)
            .map_err(|_| unsafe_path())?;
        for relative in destinations {
            let resolved = self
                .installation
                .validate_data_root(&self.data_root.join(relative))
                .map_err(|_| unsafe_path())?;
            if !resolved.starts_with(&root) {
                return Err(unsafe_path());
            }
        }
        Ok(root)
    }
}

impl AppSettingsMutationPort for NativeAppSettingsMutation {
    fn apply(&self, patch: Value, projection: Value) -> ApplicationFuture<()> {
        let this = Self {
            configuration: self.configuration.clone(),
            profile: self.profile.clone(),
            installation: self.installation.clone(),
            data_root: self.data_root.clone(),
        };
        Box::pin(async move { this.apply_inner(patch, projection).await })
    }
}

fn environment_key(provider: &str) -> Option<&'static str> {
    match provider {
        "brave" => Some("BUTLER_BRAVE_SEARCH_API_KEY"),
        "tavily" => Some("BUTLER_TAVILY_API_KEY"),
        "openai-web-search" => Some("OPENAI_API_KEY"),
        _ => None,
    }
}

fn unsafe_path() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "settings_path_unsafe".into(),
        message: "Settings destination is not safe.".into(),
    }
}
