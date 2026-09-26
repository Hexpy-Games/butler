//! Authenticated local App settings adapter for BTCC Worker profiles.

use serde_json::Value;

use crate::{
    btcc::{BtccError, PortFuture, WorkerProfile, WorkerProfileReader},
    gateway::LocalAuthConfig,
};

use super::service_configuration::NativeAppServiceConfiguration;

pub(crate) struct NativeWorkerProfileReader {
    url: String,
    auth: LocalAuthConfig,
    client: reqwest::Client,
}

impl NativeWorkerProfileReader {
    pub(crate) fn new(
        config: &NativeAppServiceConfiguration,
        auth: LocalAuthConfig,
    ) -> Result<Self, BtccError> {
        if !matches!(config.host.as_str(), "127.0.0.1" | "localhost" | "::1") {
            return Err(error("worker_profile_app_endpoint_not_local"));
        }
        let host = if config.host == "::1" {
            "[::1]"
        } else {
            config.host.as_str()
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| error("worker_profile_reader_unavailable"))?;
        Ok(Self {
            url: format!("http://{host}:{}/settings", config.port),
            auth,
            client,
        })
    }
}

impl WorkerProfileReader for NativeWorkerProfileReader {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async move {
            let profiles = self.fetch().await?;
            profiles.iter().map(parse_profile).collect()
        })
    }

    fn read(&self, profile_id: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async move {
            let profiles = self.fetch().await?;
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

impl NativeWorkerProfileReader {
    async fn fetch(&self) -> Result<Vec<Value>, BtccError> {
        let mut request = self.client.get(&self.url);
        if self.auth.required {
            let token = self
                .auth
                .token()
                .ok_or_else(|| error("app_local_auth_unconfigured"))?;
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|_| error("worker_profile_settings_unavailable"))?;
        if !response.status().is_success() {
            return Err(error("worker_profile_settings_unavailable"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| error("worker_profile_settings_invalid"))?;
        let body: Value =
            serde_json::from_slice(&bytes).map_err(|_| error("worker_profile_settings_invalid"))?;
        body.get("data")
            .and_then(|value| value.get("worker_profiles"))
            .and_then(Value::as_array)
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
