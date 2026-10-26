//! Authenticated local App settings adapter for BTCC Worker profiles.

use serde_json::Value;

use butler_turn::btcc::{BtccError, PortFuture, WorkerProfile, WorkerProfileReader};

use crate::host::ActiveAppEndpoint;

pub(crate) struct AppWorkerProfileReader {
    endpoint: std::sync::Arc<ActiveAppEndpoint>,
    client: butler_log::http::Client,
}

impl AppWorkerProfileReader {
    pub(crate) fn new(endpoint: std::sync::Arc<ActiveAppEndpoint>) -> Result<Self, BtccError> {
        let client = butler_log::http::loopback()
            .redirect(butler_log::http::RedirectPolicy::none())
            .build()
            .map_err(|source| error("worker_profile_reader_unavailable").with_source(source))?;
        Ok(Self { endpoint, client })
    }
}

impl WorkerProfileReader for AppWorkerProfileReader {
    fn background_model(&self, fallback: String) -> PortFuture<'_, String> {
        Box::pin(async move {
            let settings = self.fetch().await?;
            Ok(resolve_model(&settings, None, &fallback))
        })
    }

    fn max_simultaneous_workers(&self) -> PortFuture<'_, u64> {
        Box::pin(async move {
            self.fetch()
                .await?
                .get("max_simultaneous_workers")
                .and_then(Value::as_u64)
                .filter(|n| (1..=10).contains(n))
                .ok_or_else(|| error("worker_profile_settings_invalid"))
        })
    }

    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async move {
            let settings = self.fetch().await?;
            let profiles = settings
                .get("worker_profiles")
                .and_then(Value::as_array)
                .ok_or_else(|| error("worker_profiles_missing"))?;
            profiles
                .iter()
                .map(|value| parse_profile(value, &settings))
                .collect()
        })
    }

    fn read(&self, profile_id: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async move {
            let settings = self.fetch().await?;
            let profiles = settings
                .get("worker_profiles")
                .and_then(Value::as_array)
                .ok_or_else(|| error("worker_profiles_missing"))?;
            let selected = profile_id.as_deref().unwrap_or("default");
            let profile = profiles
                .iter()
                .find(|value| value.get("id").and_then(Value::as_str) == Some(selected))
                .ok_or_else(|| error("worker_profile_unavailable"))?;
            let profile = parse_profile(profile, &settings)?;
            if !profile.enabled {
                return Err(error("worker_profile_unavailable"));
            }
            Ok(profile)
        })
    }
}

impl AppWorkerProfileReader {
    async fn fetch(&self) -> Result<Value, BtccError> {
        let endpoint = self
            .endpoint
            .snapshot()
            .ok_or_else(|| error("worker_profile_settings_unavailable"))?;
        if !matches!(
            endpoint.configured_host.as_str(),
            "127.0.0.1" | "localhost" | "::1"
        ) {
            return Err(error("worker_profile_app_endpoint_not_local"));
        }
        let mut request = self.client.get(format!("{}/settings", endpoint.base_url));
        if endpoint.local_auth.required {
            let token = endpoint
                .local_auth
                .token()
                .ok_or_else(|| error("app_local_auth_unconfigured"))?;
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|source| error("worker_profile_settings_unavailable").with_source(source))?;
        if !response.status().is_success() {
            return Err(error("worker_profile_settings_unavailable"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|source| error("worker_profile_settings_invalid").with_source(source))?;
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|source| error("worker_profile_settings_invalid").with_source(source))?;
        body.get("data")
            .cloned()
            .ok_or_else(|| error("worker_profiles_missing"))
    }
}

fn parse_profile(value: &Value, settings: &Value) -> Result<WorkerProfile, BtccError> {
    let required = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| error("worker_profile_settings_invalid"))
    };
    let job = value
        .get("job")
        .filter(|job| job.is_object())
        .cloned()
        .ok_or_else(|| error("worker_profile_settings_invalid"))?;
    Ok(WorkerProfile {
        id: required("id")?,
        label: required("label")?,
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| error("worker_profile_settings_invalid"))?,
        model_ref: resolve_model(
            settings,
            (value.get("model_explicit").and_then(Value::as_bool) != Some(false))
                .then(|| value.get("model").and_then(Value::as_str))
                .flatten(),
            &required("model")?,
        ),
        reasoning_effort: required("reasoning_effort")?,
        prompt: value
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_owned),
        job,
    })
}

fn error(code: &'static str) -> BtccError {
    BtccError::relayed(code, code)
}

// The gateway projects availability against the current catalog. A missing
// background selection follows the supplied parent/profile fallback.
fn resolve_model(settings: &Value, explicit: Option<&str>, fallback: &str) -> String {
    let background = settings.get("background_model").and_then(Value::as_str);
    butler_core::configuration::resolve_background_model(
        explicit,
        background,
        Some(fallback),
        |value| {
            settings
                .get("effective_background_model")
                .and_then(Value::as_str)
                == Some(value)
        },
    )
    .unwrap_or(fallback)
    .to_owned()
}
