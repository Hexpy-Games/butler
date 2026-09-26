//! One-shot model/configuration facts for the read-only status commands.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json};

use crate::btcc::ModelRoundError;
use crate::{configuration::ConfigurationWrites, locale::LocaleCollation};

use super::{
    ModelCatalog, ModelCatalogError, ModelConfiguration, ModelConfigurationEnvironment,
    PromptCacheRetention, ProviderPromptCachePolicy, ProviderRequestConfigPort, parse_model_ref,
    provider_http_client,
};

pub(crate) struct NativeStatusModels {
    pub(crate) configuration: Arc<ModelConfiguration>,
    pub(crate) catalog: Arc<ModelCatalog>,
    pub(crate) model_ref: String,
    pub(crate) runtime: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) auth: Value,
    prompt_cache: Value,
}

impl NativeStatusModels {
    pub(crate) fn status_value(&self, telemetry: &Value) -> Value {
        let mut prompt_cache = self.prompt_cache.clone();
        prompt_cache["telemetry"] = telemetry_projection(telemetry);
        if let Some(object) = prompt_cache.as_object_mut() {
            object.insert("scope".into(), Value::Null);
        }
        json!({
            "runtime": self.runtime,
            "provider": self.provider,
            "model": self.model,
            "modelRef": self.model_ref,
            "auth": self.auth,
            "promptCache": prompt_cache
        })
    }

    pub(crate) fn cache_policy_text(&self, scope: Option<&str>) -> String {
        let configured = self.prompt_cache["configured"].as_bool().unwrap_or(false);
        if !configured {
            return "default".into();
        }
        let prefix = self.prompt_cache["keyPrefix"].as_str();
        let effective = match (prefix, scope.filter(|scope| !scope.is_empty())) {
            (Some(prefix), Some(scope)) => Some(format!("{prefix}:{scope}")),
            (Some(prefix), None) => Some(prefix.to_owned()),
            _ => None,
        };
        [
            effective.map(|value| format!("key={value}")),
            self.prompt_cache["retention"]
                .as_str()
                .map(|value| format!("retention={value}")),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ")
    }

    pub(crate) fn render_text(&self, telemetry: &Value, scope: Option<&str>) -> String {
        let policy = self.prompt_cache.clone();
        let prefix = policy.get("keyPrefix").and_then(Value::as_str);
        let effective_key = match (prefix, scope.filter(|scope| !scope.is_empty())) {
            (Some(prefix), Some(scope)) => Some(format!("{prefix}:{scope}")),
            (Some(prefix), None) => Some(prefix.to_owned()),
            _ => None,
        };
        let retention = policy
            .get("retention")
            .and_then(Value::as_str)
            .unwrap_or("none");
        let configured = policy
            .get("configured")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let supported = policy
            .get("supported")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let telemetry = telemetry_projection(telemetry);
        let request_count = telemetry["requestCount"].as_u64().unwrap_or(0);
        let cached = telemetry["cachedTokens"].as_f64().unwrap_or(0.0);
        let prompt = telemetry["promptTokens"].as_f64().unwrap_or(0.0);
        let ratio = if prompt == 0.0 {
            "n/a".to_owned()
        } else {
            format!("{:.1}%", cached / prompt * 100.0)
        };
        format!(
            "Runtime: {}\nProvider: {}\nModel: {}\nModel ref: {}\nAuth: {}\nPrompt cache policy: supported={} configured={} retention={} key={}\nPrompt cache telemetry: requests={} cached={}/{} hit={}",
            self.runtime,
            self.provider,
            self.model,
            self.model_ref,
            auth_text(&self.auth),
            supported,
            configured,
            retention,
            effective_key.as_deref().unwrap_or("none"),
            request_count,
            format_count(cached),
            format_count(prompt),
            ratio,
        )
    }
}

/// The status model owner could not be opened. `Display` is the CLI message.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StatusModelsError {
    /// The collation locale could not be built.
    #[error("model_status_unavailable: {0}")]
    Locale(#[source] crate::locale::LocaleError),
    /// The catalog or model configuration could not be opened.
    #[error("model_status_unavailable: {0}")]
    Catalog(#[source] ModelCatalogError),
    /// The provider HTTP client could not be built.
    #[error("model_status_unavailable: {0}")]
    HttpClient(#[source] reqwest::Error),
    /// Model metadata could not be read. The message keeps the historical
    /// `ModelCatalogError("..")` rendering the status CLI has always printed.
    #[error("model_status_unavailable: ModelCatalogError({:?})", .0.to_string())]
    Metadata(#[source] ModelCatalogError),
    /// The effective prompt model could not be resolved.
    #[error("model_status_unavailable: {0:?}")]
    PromptModel(ModelRoundError),
}

pub(crate) async fn open_status_models(
    data_root: PathBuf,
) -> Result<NativeStatusModels, StatusModelsError> {
    let environment = status_environment();
    let collation = Arc::new(LocaleCollation::new("en-US").map_err(StatusModelsError::Locale)?);
    let catalog = Arc::new(ModelCatalog::new().map_err(StatusModelsError::Catalog)?);
    let client = provider_http_client().map_err(StatusModelsError::HttpClient)?;
    let configuration = Arc::new(
        ModelConfiguration::new(
            data_root.clone(),
            environment,
            Arc::new(StatusClock),
            Arc::clone(&catalog),
            collation,
            client,
            Arc::new(ConfigurationWrites::new()),
        )
        .map_err(StatusModelsError::Catalog)?,
    );
    let metadata = configuration
        .read_metadata()
        .await
        .map_err(StatusModelsError::Metadata)?;
    let model_ref = configuration
        .effective_prompt_model(None)
        .map_err(StatusModelsError::PromptModel)?;
    let parsed = parse_model_ref(&model_ref);
    let _model_metadata = metadata.catalog.resolve_model_metadata(Some(&model_ref));
    let runtime = if parsed.provider_id == "local" {
        "local".to_owned()
    } else {
        runtime_from(&metadata.config)
    };
    let auth = auth_status(&data_root);
    let prompt_cache = prompt_cache_policy(configuration.status_prompt_cache_policy());
    Ok(NativeStatusModels {
        configuration,
        catalog,
        model_ref: parsed.canonical_ref,
        runtime,
        provider: parsed.provider_id,
        model: parsed.model_id,
        auth,
        prompt_cache,
    })
}

struct StatusClock;

impl super::ModelConfigurationClock for StatusClock {
    fn now_iso(&self) -> String {
        let millis = <Self as super::ModelConfigurationClock>::now_epoch_millis(self);
        DateTime::<Utc>::from_timestamp_millis(millis)
            .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned())
    }

    fn now_epoch_millis(&self) -> i64 {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        i64::try_from(millis).unwrap_or(i64::MAX)
    }
}

fn status_environment() -> ModelConfigurationEnvironment {
    ModelConfigurationEnvironment {
        openai_model: env_value("BUTLER_OPENAI_MODEL"),
        openai_reasoning_effort: env_value("BUTLER_OPENAI_REASONING_EFFORT"),
        openai_api_key: env_value("OPENAI_API_KEY"),
        openai_base_url: env_value("OPENAI_BASE_URL"),
        openai_prompt_cache_key_prefix: env_value("BUTLER_OPENAI_PROMPT_CACHE_KEY_PREFIX"),
        openai_prompt_cache_retention: env_value("BUTLER_OPENAI_PROMPT_CACHE_RETENTION"),
        butler_codex_auth_profile: std::env::var_os("BUTLER_CODEX_AUTH_PROFILE").map(PathBuf::from),
        butler_openai_auth_profile: std::env::var_os("BUTLER_OPENAI_AUTH_PROFILE")
            .map(PathBuf::from),
        codex_auth_json: std::env::var_os("CODEX_AUTH_JSON").map(PathBuf::from),
        ..ModelConfigurationEnvironment::default()
    }
}

fn runtime_from(config: &Value) -> String {
    let runtime = env_value("BUTLER_RUNTIME").or_else(|| {
        config
            .pointer("/system/runtime")
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    match runtime.as_deref() {
        Some("local") => "local".into(),
        _ => "codex-api".into(),
    }
}

pub(crate) fn auth_status(data_root: &Path) -> Value {
    auth_status_with_environment(data_root, &HashMap::new())
}

pub(crate) fn auth_status_with_environment(
    data_root: &Path,
    private_environment: &HashMap<String, String>,
) -> Value {
    if auth_value("OPENAI_API_KEY", private_environment).is_some() {
        return json!({ "configured": true, "mode": "api_key", "source": "OPENAI_API_KEY" });
    }
    let profile = auth_value("BUTLER_CODEX_AUTH_PROFILE", private_environment)
        .or_else(|| auth_value("BUTLER_OPENAI_AUTH_PROFILE", private_environment))
        .map(|profile| data_profile_path(data_root, &profile))
        .unwrap_or_else(|| data_root.join("auth/openai-codex.json"));
    if std::fs::metadata(&profile).is_ok_and(|metadata| metadata.len() > 0) {
        return json!({ "configured": true, "mode": "codex_subscription", "source": "BUTLER_CODEX_AUTH_PROFILE" });
    }
    let codex = auth_value("CODEX_AUTH_JSON", private_environment)
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex/auth.json"))
        });
    if codex.is_some_and(|path| std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0)) {
        return json!({ "configured": true, "mode": "codex_oauth", "source": "CODEX_AUTH_JSON" });
    }
    json!({ "configured": false, "mode": "missing", "source": null })
}

fn data_profile_path(data_root: &Path, profile: &str) -> PathBuf {
    let profile = PathBuf::from(profile);
    if profile.is_absolute() {
        profile
    } else {
        data_root.join(profile)
    }
}

fn auth_value(name: &str, private_environment: &HashMap<String, String>) -> Option<String> {
    env_value(name).or_else(|| {
        private_environment
            .get(name)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn prompt_cache_policy(policy: ProviderPromptCachePolicy) -> Value {
    let key_prefix = policy.key_prefix;
    let retention = policy.retention.map(|retention| match retention {
        PromptCacheRetention::InMemory => "in_memory",
        PromptCacheRetention::Hours24 => "24h",
    });
    let configured = key_prefix.is_some() || retention.is_some();
    json!({
        "supported": true,
        "configured": configured,
        "keyPrefix": key_prefix.clone(),
        "retention": retention,
        "effectiveKey": key_prefix,
        "scope": null
    })
}

fn telemetry_projection(telemetry: &Value) -> Value {
    json!({
        "requestCount": telemetry.get("requestCount").cloned().unwrap_or(json!(0)),
        "promptTokens": telemetry.get("promptTokens").cloned().unwrap_or(json!(0)),
        "cachedTokens": telemetry.get("cachedTokens").cloned().unwrap_or(json!(0)),
        "totalTokens": telemetry.get("totalTokens").cloned().unwrap_or(json!(0)),
        "cacheHitRatio": telemetry.get("cacheHitRatio").cloned().unwrap_or(json!(0.0)),
        "byScope": telemetry.get("byScope").cloned().unwrap_or_else(|| json!({}))
    })
}

fn auth_text(auth: &Value) -> String {
    let configured = auth
        .get("configured")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mode = auth
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("missing");
    let source = auth.get("source").and_then(Value::as_str);
    if configured {
        source.map_or_else(|| mode.to_owned(), |source| format!("{mode} ({source})"))
    } else {
        "missing".to_owned()
    }
}

fn format_count(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}
