//! Remaining-quota polls of the providers that offer a usage endpoint.
//!
//! The credential and endpoint are resolved here, from the same login and
//! registered models the provider requests use; only the parsed reading
//! leaves the Models port.
//!
//! - `zai` (Coding Plan): `GET <origin>/api/monitor/usage/quota/limit` with
//!   the bare API key. The origin is taken only from an official Coding Plan
//!   base URL (`https://api.z.ai` or `https://open.bigmodel.cn`, path
//!   `/api/coding/paas/v4`), never from another host. The process
//!   environment override (`BUTLER_ZAI_BASE_URL`) may also name a loopback
//!   origin, which the E2E record/replay provider uses.

use reqwest::Url;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};

use super::{ModelConfiguration, ModelConfigurationRead};
use crate::models::quota::parse_zai_quota;
use crate::models::{
    ProviderAuthMethod, ProviderQuotaReading, QuotaBilling, QuotaFetch, QuotaFetchError, QuotaHttp,
    QuotaSupport, default_hosted_provider_api_base_url, provider_quota_support,
};

const ZAI_CODING_PATH: &str = "/api/coding/paas/v4";
const ZAI_QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";
const ZAI_OFFICIAL_HOSTS: [&str; 2] = ["api.z.ai", "open.bigmodel.cn"];

impl ModelConfiguration {
    /// Connects account changes to the same quota owner used by model responses.
    pub fn set_provider_quota_sink(
        &self,
        sink: std::sync::Arc<dyn crate::models::ProviderQuotaSink>,
    ) {
        *self.quota_sink.write() = Some(sink);
    }

    pub(super) fn provider_account_changed(&self, provider: &str) {
        if let Some(sink) = self.quota_sink.read().as_ref() {
            sink.account_changed(provider);
        }
    }

    /// Butler's own User-Agent for quota polls, `butler (<os> <release>;
    /// <arch>)` like its model requests; never another client's.
    pub fn quota_user_agent(&self) -> String {
        let fact = |value: &Option<String>| {
            value
                .as_deref()
                .map(butler_core::public_text::trim_js_whitespace)
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown")
                .to_owned()
        };
        format!(
            "butler ({} {}; {})",
            fact(&self.environment.os_platform),
            fact(&self.environment.os_release),
            fact(&self.environment.os_arch)
        )
    }

    /// Reads `provider_id`'s remaining quota from its usage endpoint. With
    /// `allow_refresh`, a Codex token the endpoint rejects (HTTP 401) is
    /// refreshed once, unless the stored login already changed, and the
    /// read retried with the renewed token.
    pub async fn fetch_provider_quota(
        &self,
        provider_id: &str,
        http: &QuotaHttp,
        _allow_refresh: bool,
    ) -> QuotaFetch {
        match (provider_quota_support(provider_id), provider_id) {
            (QuotaSupport::NotOffered(billing), _) => {
                Err(QuotaFetchError::NotOffered(billing)).into()
            }
            (QuotaSupport::Polled, _) => self.fetch_zai_quota(http).await.into(),
        }
    }

    async fn fetch_zai_quota(
        &self,
        http: &QuotaHttp,
    ) -> Result<ProviderQuotaReading, QuotaFetchError> {
        let read = self
            .read()
            .await
            .map_err(|_| QuotaFetchError::Configuration)?;
        let environment_base = self
            .environment
            .hosted_provider_base_urls
            .get("zai")
            .map(String::as_str);
        let (credential, url) = zai_target(&read, environment_base)?;
        // Read from its store for this request only (#217).
        let key = self
            .credential_secret(&self.data_root, credential)
            .await
            .map_err(|_| QuotaFetchError::NotConfigured)?;
        let mut headers = base_headers(http)?;
        headers.insert(AUTHORIZATION, header(key.expose())?);
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en"));
        let body = http.get(&url, &headers).await?;
        parse_zai_quota("zai", &body, self.clock.now_epoch_millis())
    }
}

/// The Coding Plan key (its saved credential) and quota URL of the
/// registered `zai` models. They must all use one API-key credential and one
/// eligible endpoint.
fn zai_target<'a>(
    read: &'a ModelConfigurationRead,
    environment_base: Option<&str>,
) -> Result<(&'a super::credentials::CredentialRecord, Url), QuotaFetchError> {
    let configs: Vec<_> = read
        .registered
        .iter()
        .filter(|config| config.provider_id == "zai")
        .collect();
    let first = configs.first().ok_or(QuotaFetchError::NotConfigured)?;
    let mut target: Option<(&super::credentials::CredentialRecord, Url)> = None;
    for config in &configs {
        if config.auth_type != ProviderAuthMethod::ApiKey
            || config.credential_id != first.credential_id
        {
            return Err(QuotaFetchError::NotOffered(QuotaBilling::Subscription));
        }
        let url = match config.api_base_url.as_deref() {
            Some(base) => zai_quota_url(base, false),
            None => environment_base
                .map(|base| zai_quota_url(base, true))
                .unwrap_or_else(|| {
                    default_hosted_provider_api_base_url("zai")
                        .and_then(|base| zai_quota_url(base, false))
                }),
        }
        .ok_or(QuotaFetchError::NotOffered(QuotaBilling::Subscription))?;
        if target.as_ref().is_some_and(|(_, known)| *known != url) {
            return Err(QuotaFetchError::NotOffered(QuotaBilling::Subscription));
        }
        let key = config
            .credential_id
            .as_deref()
            .and_then(|id| read.credential(id, "zai"))
            .ok_or(QuotaFetchError::NotConfigured)?;
        target = Some((key, url));
    }
    target.ok_or(QuotaFetchError::NotConfigured)
}

/// The quota URL of a Coding Plan base URL, `None` for any other endpoint.
/// `loopback_allowed` admits a loopback origin (process environment only).
fn zai_quota_url(base: &str, loopback_allowed: bool) -> Option<Url> {
    let url = Url::parse(butler_core::public_text::trim_js_whitespace(base)).ok()?;
    if url.path().trim_end_matches('/') != ZAI_CODING_PATH
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let official =
        url.scheme() == "https" && url.port().is_none() && ZAI_OFFICIAL_HOSTS.contains(&host);
    let loopback = loopback_allowed
        && matches!(url.scheme(), "http" | "https")
        && matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    if !(official || loopback) {
        return None;
    }
    url.join(ZAI_QUOTA_PATH).ok()
}

fn base_headers(http: &QuotaHttp) -> Result<HeaderMap, QuotaFetchError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, header(http.user_agent())?);
    Ok(headers)
}

/// A header value; a credential that is not a valid header cannot be sent.
fn header(value: &str) -> Result<HeaderValue, QuotaFetchError> {
    let mut value = HeaderValue::from_str(value).map_err(|_| QuotaFetchError::NotConfigured)?;
    value.set_sensitive(true);
    Ok(value)
}

#[cfg(test)]
mod tests;

/// Metadata checks do not reread unchanged config or credential files.
pub(super) struct Configuration {
    refresh: tokio::sync::Mutex<()>,
    state: parking_lot::RwLock<Eligibility>,
    changes: tokio::sync::watch::Sender<u64>,
}
#[derive(Default)]
struct Eligibility {
    stamps: Option<Vec<Option<(std::time::SystemTime, u64)>>>,
    providers: Vec<String>,
    bindings: std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
    disabled: Vec<String>,
    chatgpt: bool,
}
impl ModelConfiguration {
    /// Update only when registry/config/credential facts changed; no resident task.
    pub async fn refresh_quota_configuration(
        &self,
    ) -> Result<(), crate::models::ModelCatalogError> {
        let _refresh = self.quota_configuration.refresh.lock().await;
        let mut stamps = Vec::new();
        for file in ["butler.config.json", super::credentials::CREDENTIALS_FILE] {
            stamps.push(
                tokio::fs::metadata(self.data_root.join(file))
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok().map(|time| (time, m.len()))),
            );
        }
        if self.quota_configuration.state.read().stamps.as_ref() == Some(&stamps) {
            return Ok(());
        }
        let read = self.read().await?;
        let state = Eligibility::from_read(&read, stamps);
        if let Some(sink) = self.quota_sink.read().as_ref() {
            let previous = self.quota_configuration.state.read();
            for (provider, bindings) in &previous.bindings {
                if state.bindings.get(provider) != Some(bindings) {
                    sink.account_changed(provider);
                }
            }
            sink.registered_providers(&state.providers, state.chatgpt);
        }
        *self.quota_configuration.state.write() = state;
        self.quota_configuration
            .changes
            .send_modify(|revision| *revision = revision.wrapping_add(1));
        Ok(())
    }
    pub fn quota_configuration_changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.quota_configuration.changes.subscribe()
    }
    /// Registered credential bindings, in registry order; never inferred from telemetry.
    pub fn quota_providers(&self) -> Vec<String> {
        self.quota_configuration.state.read().providers.clone()
    }
    pub fn quota_polling_enabled(&self, provider: &str) -> bool {
        let state = self.quota_configuration.state.read();
        state.providers.iter().any(|p| p == provider)
            && !state.disabled.iter().any(|p| p == provider)
    }
    /// The config switch is independent of whether a model currently binds the provider.
    pub fn quota_polling_configured(&self, provider: &str) -> bool {
        !self
            .quota_configuration
            .state
            .read()
            .disabled
            .iter()
            .any(|id| id == provider)
    }
    pub fn uses_chatgpt_quota(&self) -> bool {
        self.quota_configuration.state.read().chatgpt
    }
}

impl Default for Configuration {
    fn default() -> Self {
        Self {
            refresh: Default::default(),
            state: Default::default(),
            changes: tokio::sync::watch::channel(0).0,
        }
    }
}

impl Eligibility {
    fn from_read(
        read: &ModelConfigurationRead,
        stamps: Vec<Option<(std::time::SystemTime, u64)>>,
    ) -> Self {
        let mut state = Eligibility {
            stamps: Some(stamps),
            ..Default::default()
        };
        for model in &read.registered {
            let uses = match model.auth_type {
                ProviderAuthMethod::ApiKey => model
                    .credential_id
                    .as_deref()
                    .and_then(|id| read.credential(id, &model.provider_id))
                    .is_some(),
                ProviderAuthMethod::ChatGptOauth => true,
            };
            if !uses {
                continue;
            }
            state
                .bindings
                .entry(model.provider_id.clone())
                .or_default()
                .insert(format!(
                    "{:?}:{}",
                    model.auth_type,
                    model.credential_id.as_deref().unwrap_or_default()
                ));
            state.chatgpt |= model.auth_type == ProviderAuthMethod::ChatGptOauth;
            if !state.providers.contains(&model.provider_id) {
                state.providers.push(model.provider_id.clone());
            }
        }
        if let Some(providers) = read
            .config
            .get("providerQuota")
            .and_then(serde_json::Value::as_object)
        {
            state.disabled = providers
                .iter()
                .filter(|(_, value)| {
                    value.get("polling").and_then(serde_json::Value::as_bool) == Some(false)
                })
                .map(|(id, _)| id.clone())
                .collect();
        }
        state
    }
}
