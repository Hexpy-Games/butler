//! Authenticated local App settings adapter for BTCC Worker profiles.

use serde_json::Value;

use butler_turn::btcc::{BtccError, PortFuture, WorkerProfile, WorkerProfileReader};

use crate::host::ActiveAppEndpoint;

pub(crate) struct AppWorkerProfileReader {
    endpoint: ActiveAppEndpoint,
    client: reqwest::Client,
}

impl AppWorkerProfileReader {
    pub(crate) fn new(endpoint: ActiveAppEndpoint) -> Result<Self, BtccError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|source| error("worker_profile_reader_unavailable").with_source(source))?;
        Ok(Self { endpoint, client })
    }
}

impl WorkerProfileReader for AppWorkerProfileReader {
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

impl AppWorkerProfileReader {
    async fn fetch(&self) -> Result<Vec<Value>, BtccError> {
        let active = self
            .endpoint
            .snapshot()
            .ok_or_else(|| error("worker_profile_settings_unavailable"))?;
        let mut request = self.client.get(format!("{}/settings", active.base_url));
        if active.local_auth.required {
            let token = active
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
