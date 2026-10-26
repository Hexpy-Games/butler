//! App preference side effects through the existing Profile and Models owners.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::host::ResolvedInstallation;
use butler_gateway::gateway::{
    AppSettingsMutationPort, ApplicationFuture, GatewayApplicationError,
};
use butler_memory::profile::ProfileService;
use butler_models::models::ModelConfiguration;

pub(crate) struct AppSettingsMutation {
    configuration: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    installation: ResolvedInstallation,
    data_root: PathBuf,
    gate: Arc<crate::host::memory_jobs::consolidation::ConsolidationRunGate>,
}

impl AppSettingsMutation {
    pub(in crate::host) fn new(
        configuration: Arc<ModelConfiguration>,
        profile: Arc<ProfileService>,
        installation: ResolvedInstallation,
        data_root: PathBuf,
        gate: Arc<crate::host::memory_jobs::consolidation::ConsolidationRunGate>,
    ) -> Self {
        Self {
            configuration,
            profile,
            installation,
            data_root,
            gate,
        }
    }

    /// The Settings model is the default model: `butler model status` and
    /// every non-App reader of butler.config.json must agree with it.
    async fn sync_default_model(
        &self,
        patch: &Value,
        projection: &Value,
    ) -> Result<(), GatewayApplicationError> {
        if patch.get("model").is_some()
            && let Some(model) = projection.get("model").and_then(Value::as_str)
        {
            self.configuration
                .set_default_model(model)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        Ok(())
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
        let writes_config = patch.contains_key("update_previews")
            || [
                "proactive_level",
                "quiet_hours_start",
                "quiet_hours_end",
                "chats_intro_seen",
            ]
            .iter()
            .any(|k| patch.contains_key(*k))
            || patch.contains_key("consolidation_time")
            || patch.contains_key("consolidation_model")
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
            destinations.push(butler_platform::data_paths::ENVIRONMENT);
        }
        let root = self.validated_root(&destinations)?;

        self.apply_source_settings(&patch, &root).await?;
        if let (Some(key), Some(value)) = (environment_key, api_key) {
            self.configuration
                .upsert_private_environment_value(key, value, &root)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        if patch.contains_key("web_search") {
            let web_search = projection.get("web_search").unwrap_or(&Value::Null);
            let config_patch = json!({
                "provider": web_search.get("provider"),
                "readerBackend": chosen_reader(&patch, web_search),
                "planning": {
                    "enabled": web_search.get("planning_enabled"),
                    "defaultDepth": web_search.get("planning_default_depth"),
                }
            });
            self.configuration
                .update_web_search_settings(&config_patch, &root)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }

        self.apply_user_settings(&patch, &projection, &root).await
    }

    async fn apply_source_settings(
        &self,
        patch: &Map<String, Value>,
        root: &std::path::Path,
    ) -> Result<(), GatewayApplicationError> {
        self.apply_profile_and_channel(patch, root).await?;
        if [
            "proactive_level",
            "quiet_hours_start",
            "quiet_hours_end",
            "chats_intro_seen",
        ]
        .iter()
        .any(|k| patch.contains_key(*k))
        {
            self.configuration
                .set_proactive_settings(&Value::Object(patch.clone()), root)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        Ok(())
    }

    async fn apply_user_settings(
        &self,
        patch: &Map<String, Value>,
        projection: &Value,
        root: &std::path::Path,
    ) -> Result<(), GatewayApplicationError> {
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
                .update_user_settings(&Value::Object(user_patch), Some(root))
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        if let Some(timezone) = patch.get("timezone").and_then(Value::as_str) {
            self.gate
                .set_timezone(timezone.to_owned())
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        Ok(())
    }

    async fn apply_profile_and_channel(
        &self,
        patch: &serde_json::Map<String, Value>,
        root: &std::path::Path,
    ) -> Result<(), GatewayApplicationError> {
        if let Some(time) = patch.get("consolidation_time").and_then(Value::as_str) {
            self.configuration
                .set_consolidation_time(time, root)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            let now = crate::host::app::schedule_clock::clock().now_iso();
            let now = chrono::DateTime::parse_from_rfc3339(&now)
                .map_err(GatewayApplicationError::internal_from)?
                .timestamp_millis();
            self.gate
                .set_time(time.to_owned(), now)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        if let Some(enabled) = patch.get("update_previews").and_then(Value::as_bool) {
            self.configuration
                .set_update_previews(enabled, root)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        if let Some(model) = patch.get("consolidation_model").and_then(Value::as_str) {
            self.profile
                .set_extractor_model(Some(model.to_owned()))
                .await
                .map_err(GatewayApplicationError::internal_from)?;
        }
        if let Some(effort) = patch
            .get("consolidation_reasoning_effort")
            .and_then(Value::as_str)
        {
            self.profile
                .set_extractor_reasoning_effort(Some(effort.to_owned()))
                .await
                .map_err(GatewayApplicationError::internal_from)?;
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
            .map_err(|source| unsafe_path().with_source(source))?;
        for relative in destinations {
            let resolved = self
                .installation
                .validate_data_root(&self.data_root.join(relative))
                .map_err(|source| unsafe_path().with_source(source))?;
            if !resolved.starts_with(&root) {
                return Err(unsafe_path());
            }
        }
        Ok(root)
    }
}

impl AppSettingsMutationPort for AppSettingsMutation {
    fn apply(&self, patch: Value, projection: Value) -> ApplicationFuture<()> {
        let this = Self {
            configuration: self.configuration.clone(),
            profile: self.profile.clone(),
            installation: self.installation.clone(),
            data_root: self.data_root.clone(),
            gate: self.gate.clone(),
        };
        Box::pin(async move {
            this.apply_inner(patch.clone(), projection.clone()).await?;
            this.sync_default_model(&patch, &projection).await
        })
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
        source: None,
    }
}

/// The page reader is written only when the patch chooses one, so a stored
/// old value never turns the migrated default into an explicit choice.
fn chosen_reader<'a>(patch: &Map<String, Value>, web_search: &'a Value) -> Option<&'a Value> {
    patch
        .get("web_search")
        .and_then(|value| value.get("reader_backend"))
        .and(web_search.get("reader_backend"))
}
