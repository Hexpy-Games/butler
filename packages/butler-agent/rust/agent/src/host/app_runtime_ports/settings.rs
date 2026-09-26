//! One replaceable App facts snapshot from the real model configuration owner.

use parking_lot::RwLock;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;

use crate::{
    btcc::ReasoningEffort as BtccReasoningEffort,
    gateway::{
        AppModelFallbackFacts, AppModelMetadata, AppSettingsFacts, AppSettingsFactsProvider,
        GatewayApplicationError,
    },
    models::{ModelConfiguration, ModelProviderMetadata, ReasoningEffort as ModelReasoningEffort},
    profile::ProfileService,
};

pub(crate) struct NativeAppSettingsFacts {
    configuration: Arc<ModelConfiguration>,
    profile: Arc<ProfileService>,
    data_root: PathBuf,
    server_url: String,
    bridge_mode: String,
    current: Arc<RwLock<Arc<AppSettingsFacts>>>,
}

impl NativeAppSettingsFacts {
    pub(crate) async fn open(
        configuration: Arc<ModelConfiguration>,
        profile: Arc<ProfileService>,
        data_root: PathBuf,
        server_url: String,
        bridge_mode: String,
    ) -> Result<Self, GatewayApplicationError> {
        let current = load(
            &configuration,
            &profile,
            &data_root,
            &server_url,
            &bridge_mode,
        )
        .await?;
        Ok(Self {
            configuration,
            profile,
            data_root,
            server_url,
            bridge_mode,
            current: Arc::new(RwLock::new(current)),
        })
    }

    /// Call after a successful config/model mutation; readers keep their
    /// immutable per-request snapshot while the new facts replace it.
    pub(crate) async fn refresh(&self) -> Result<(), GatewayApplicationError> {
        let next = load(
            &self.configuration,
            &self.profile,
            &self.data_root,
            &self.server_url,
            &self.bridge_mode,
        )
        .await?;
        *self.current.write() = next;
        Ok(())
    }
}

impl AppSettingsFactsProvider for NativeAppSettingsFacts {
    fn snapshot(&self) -> Result<Arc<AppSettingsFacts>, GatewayApplicationError> {
        Ok(self.current.read().clone())
    }

    fn refresh(&self) -> crate::gateway::ApplicationFuture<()> {
        let this = self.clone_for_refresh();
        Box::pin(async move { this.refresh().await })
    }
}

impl NativeAppSettingsFacts {
    fn clone_for_refresh(&self) -> Self {
        Self {
            configuration: self.configuration.clone(),
            profile: self.profile.clone(),
            data_root: self.data_root.clone(),
            server_url: self.server_url.clone(),
            bridge_mode: self.bridge_mode.clone(),
            current: self.current.clone(),
        }
    }
}

async fn load(
    configuration: &ModelConfiguration,
    profile: &ProfileService,
    data_root: &std::path::Path,
    server_url: &str,
    bridge_mode: &str,
) -> Result<Arc<AppSettingsFacts>, GatewayApplicationError> {
    let read = configuration
        .read()
        .await
        .map_err(|_| GatewayApplicationError::Internal)?;
    let catalog = read.catalog.view();
    let config_default_model = read
        .config
        .pointer("/system/butlerModel")
        .and_then(nonempty)
        .or_else(|| {
            read.config
                .pointer("/system/defaultModel")
                .and_then(nonempty)
        })
        .map(str::to_owned);
    let fallback = read.config.pointer("/user/modelFallback");
    let config_model_fallback = AppModelFallbackFacts {
        enabled: fallback
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true),
        models: fallback
            .and_then(|value| value.get("models"))
            .and_then(Value::as_array)
            .map(|array| {
                array
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
            .into(),
    };
    let extractor = profile
        .read_extractor_model()
        .await
        .map_err(|_| GatewayApplicationError::Internal)?;
    let private_environment =
        crate::configuration::read_private_environment(&data_root.join(".env"))
            .map_err(|_| GatewayApplicationError::Internal)?;
    let web_search = read.config.get("webSearch").unwrap_or(&Value::Null);
    let planning = web_search.get("planning").unwrap_or(&Value::Null);
    let native_settings = serde_json::json!({
        "bridge_mode": bridge_mode,
        "server_url": server_url,
        "config_user": {
            "language": read.config.pointer("/user/language"),
            "timezone": read.config.pointer("/user/timezone"),
        },
        "local_timezone": local_timezone(),
        "web_search": {
            "provider": web_search.get("provider"),
            "reader_backend": web_search.get("readerBackend"),
            "planning_enabled": planning.get("enabled"),
            "planning_mode": planning.get("mode"),
            "planning_default_depth": planning.get("defaultDepth"),
        },
        "web_search_credentials": web_search_credentials(&private_environment),
        "consolidation": {
            "model": extractor.configured_model,
            "reasoning_effort": extractor.reasoning_effort,
            "effective_model": extractor.effective_model,
            "uses_butler_model": extractor.uses_butler_model,
        }
    });
    Ok(Arc::new(AppSettingsFacts {
        registered_models: catalog
            .registered_models
            .iter()
            .map(model)
            .collect::<Vec<_>>()
            .into(),
        known_models: catalog.models.iter().map(model).collect::<Vec<_>>().into(),
        config_default_model,
        config_model_fallback,
        catalog_generation: catalog.generation.clone(),
        native_settings,
    }))
}

fn local_timezone() -> String {
    if let Ok(value) = std::env::var("TZ") {
        let value = value.trim_start_matches(':').trim();
        if !value.is_empty() && !value.starts_with('/') {
            return value.to_owned();
        }
    }
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|path| {
            let text = path.to_string_lossy();
            text.split("/zoneinfo/").nth(1).map(str::to_owned)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "UTC".into())
}

fn web_search_credentials(
    private_environment: &std::collections::HashMap<String, String>,
) -> Value {
    let keys = [
        (
            "brave",
            "BUTLER_BRAVE_SEARCH_API_KEY",
            &["BUTLER_BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"][..],
        ),
        (
            "tavily",
            "BUTLER_TAVILY_API_KEY",
            &["BUTLER_TAVILY_API_KEY", "TAVILY_API_KEY"][..],
        ),
        (
            "openai-web-search",
            "OPENAI_API_KEY",
            &["OPENAI_API_KEY"][..],
        ),
    ];
    let mut values = serde_json::Map::new();
    for (provider, primary, accepted) in keys {
        let configured = accepted.iter().any(|name| {
            std::env::var(name)
                .ok()
                .is_some_and(|value| !value.trim().is_empty())
                || private_environment
                    .get(*name)
                    .is_some_and(|value| !value.trim().is_empty())
        });
        values.insert(
            provider.into(),
            serde_json::json!({"configured":configured,"env_var":primary}),
        );
    }
    Value::Object(values)
}

fn nonempty(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
}

fn model(source: &ModelProviderMetadata) -> AppModelMetadata {
    AppModelMetadata {
        provider_id: source.provider_id.clone(),
        provider_family_id: source.provider_family_id.clone(),
        model_id: source.model_id.clone(),
        model_ref: source.model_ref.clone(),
        context_window_tokens: source
            .context_window_tokens
            .filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value.trunc() as u64),
        aliases: source.aliases.clone().unwrap_or_default().into(),
        runtime_supported: source.runtime_supported,
        registered: source.registered == Some(true),
        enabled: source.enabled == Some(true),
        reasoning_efforts: source
            .reasoning_efforts
            .iter()
            .copied()
            .map(reasoning_effort)
            .collect::<Vec<_>>()
            .into(),
        default_reasoning_effort: reasoning_effort(source.default_reasoning_effort),
    }
}

fn reasoning_effort(source: ModelReasoningEffort) -> BtccReasoningEffort {
    match source {
        ModelReasoningEffort::None => BtccReasoningEffort::None,
        ModelReasoningEffort::Low => BtccReasoningEffort::Low,
        ModelReasoningEffort::Medium => BtccReasoningEffort::Medium,
        ModelReasoningEffort::High => BtccReasoningEffort::High,
        ModelReasoningEffort::Xhigh => BtccReasoningEffort::Xhigh,
        ModelReasoningEffort::Max => BtccReasoningEffort::Max,
    }
}
