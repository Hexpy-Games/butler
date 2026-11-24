//! Authenticated local App settings adapter for BTCC Worker profiles.

use serde_json::Value;

use butler_turn::btcc::{BtccError, PortFuture, WorkerProfile, WorkerProfileReader};

use crate::host::{ActiveAppEndpoint, app::self_api::SelfApi};

pub(crate) struct AppWorkerProfileReader {
    endpoint: std::sync::Arc<ActiveAppEndpoint>,
}

impl AppWorkerProfileReader {
    pub(crate) fn new(endpoint: std::sync::Arc<ActiveAppEndpoint>) -> Self {
        Self { endpoint }
    }
}

impl WorkerProfileReader for AppWorkerProfileReader {
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
            let profiles = self.profiles().await?;
            profiles.iter().map(parse_profile).collect()
        })
    }

    fn read(&self, profile_id: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async move {
            let profiles = self.profiles().await?;
            let selected = profile_id.as_deref().unwrap_or("default");
            let profile = profiles
                .iter()
                .find(|value| value.get("id").and_then(Value::as_str) == Some(selected))
                .ok_or_else(|| error("worker_profile_unavailable"))?;
            let profile = parse_profile(profile)?;
            if !profile.enabled {
                return Err(error("worker_profile_unavailable"));
            }
            Ok(profile)
        })
    }
}

impl AppWorkerProfileReader {
    async fn profiles(&self) -> Result<Vec<Value>, BtccError> {
        self.fetch()
            .await?
            .get("worker_profiles")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| error("worker_profiles_missing"))
    }

    async fn fetch(&self) -> Result<Value, BtccError> {
        let endpoint = self
            .endpoint
            .snapshot()
            .ok_or_else(|| error("worker_profile_settings_unavailable"))?;
        if endpoint.local_auth.required && endpoint.local_auth.token().is_none() {
            return Err(error("app_local_auth_unconfigured"));
        }
        let response = SelfApi::new(&self.endpoint)
            .request(http::Method::GET, "/settings", None, None, None)
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

fn parse_profile(value: &Value) -> Result<WorkerProfile, BtccError> {
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
        model_ref: required("model")?,
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
