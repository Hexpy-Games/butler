//! Remaining-quota polls of the providers that offer a usage endpoint.
//!
//! The credential and endpoint are resolved here, from the same login and
//! registered models the provider requests use; only the parsed reading
//! leaves the Models port.
//!
//! - `openai` with a Codex login: `GET <codex base>/wham/usage` with the
//!   login's bearer token, `ChatGPT-Account-Id` and Butler's own
//!   User-Agent. An API key has no plan quota (`NotOffered(Api)`).
//! - `zai` (Coding Plan): `GET <origin>/api/monitor/usage/quota/limit` with
//!   the bare API key. The origin is taken only from an official Coding Plan
//!   base URL (`https://api.z.ai` or `https://open.bigmodel.cn`, path
//!   `/api/coding/paas/v4`), never from another host. The process
//!   environment override (`BUTLER_ZAI_BASE_URL`) may also name a loopback
//!   origin, which the E2E record/replay provider uses.

use reqwest::Url;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, AUTHORIZATION, HeaderMap, HeaderValue, USER_AGENT};

use super::auth::AuthOwner;
use super::{ModelConfiguration, ModelConfigurationRead, merge_private_auth_environment};
use crate::models::quota::{parse_codex_usage, parse_zai_quota};
use crate::models::{
    ProviderAuth, ProviderAuthMethod, ProviderQuotaReading, QuotaBilling, QuotaFetchError,
    QuotaHttp, QuotaSupport, default_hosted_provider_api_base_url, provider_quota_support,
};

const DEFAULT_CODEX_BASE: &str = "https://chatgpt.com/backend-api";
const ZAI_CODING_PATH: &str = "/api/coding/paas/v4";
const ZAI_QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";
const ZAI_OFFICIAL_HOSTS: [&str; 2] = ["api.z.ai", "open.bigmodel.cn"];

impl ModelConfiguration {
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

    /// Reads `provider_id`'s remaining quota from its usage endpoint.
    /// `refresh_auth` refreshes a Codex login first (after a rejected token).
    pub async fn fetch_provider_quota(
        &self,
        provider_id: &str,
        http: &QuotaHttp,
        refresh_auth: bool,
    ) -> Result<ProviderQuotaReading, QuotaFetchError> {
        match (provider_quota_support(provider_id), provider_id) {
            (QuotaSupport::NotOffered(billing), _) => Err(QuotaFetchError::NotOffered(billing)),
            (QuotaSupport::Polled, "openai") => self.fetch_codex_quota(http, refresh_auth).await,
            (QuotaSupport::Polled, _) => self.fetch_zai_quota(http).await,
        }
    }

    async fn fetch_codex_quota(
        &self,
        http: &QuotaHttp,
        refresh_auth: bool,
    ) -> Result<ProviderQuotaReading, QuotaFetchError> {
        let read = self
            .read()
            .await
            .map_err(|_| QuotaFetchError::NotConfigured)?;
        let private =
            butler_core::configuration::read_private_environment(&self.data_root.join(".env"))
                .unwrap_or_default();
        let mut environment = self.environment.clone();
        merge_private_auth_environment(&mut environment, &private);
        let owner = AuthOwner {
            data_root: &self.data_root,
            environment: &environment,
            clock: self.clock.as_ref(),
            client: &self.client,
        };
        let codex_only = read.registered.iter().any(|config| {
            config.provider_id == "openai" && config.auth_type == ProviderAuthMethod::CodexOauth
        });
        let auth = if codex_only {
            owner.resolve_codex_with(refresh_auth).await
        } else {
            owner.resolve_openai_with(refresh_auth).await
        };
        let (authorization, account_id) = match auth {
            Ok(ProviderAuth::Codex {
                authorization,
                account_id,
                ..
            }) => (authorization, account_id),
            Ok(ProviderAuth::ApiKey(_)) => {
                return Err(QuotaFetchError::NotOffered(QuotaBilling::Api));
            }
            Ok(ProviderAuth::None) => return Err(QuotaFetchError::NotConfigured),
            Err(error) if error.code == "provider_auth_missing" => {
                return Err(QuotaFetchError::NotConfigured);
            }
            Err(_) => return Err(QuotaFetchError::AuthUnavailable),
        };
        let url = codex_usage_url(environment.codex_base_url.as_deref())
            .ok_or(QuotaFetchError::NotOffered(QuotaBilling::Subscription))?;
        let mut headers = base_headers(http)?;
        headers.insert(AUTHORIZATION, header(&authorization)?);
        if !account_id.is_empty() {
            headers.insert("chatgpt-account-id", header(&account_id)?);
        }
        let body = http.get(&url, &headers).await?;
        parse_codex_usage("openai", &body, self.clock.now_epoch_millis())
    }

    async fn fetch_zai_quota(
        &self,
        http: &QuotaHttp,
    ) -> Result<ProviderQuotaReading, QuotaFetchError> {
        let read = self
            .read()
            .await
            .map_err(|_| QuotaFetchError::NotConfigured)?;
        let environment_base = self
            .environment
            .hosted_provider_base_urls
            .get("zai")
            .map(String::as_str);
        let (key, url) = zai_target(&read, environment_base)?;
        let mut headers = base_headers(http)?;
        headers.insert(AUTHORIZATION, header(key)?);
        headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en"));
        let body = http.get(&url, &headers).await?;
        parse_zai_quota("zai", &body, self.clock.now_epoch_millis())
    }
}

/// `<codex base>/wham/usage`; the base's `/codex[/responses]` suffix, which
/// names the model endpoint, is dropped.
fn codex_usage_url(configured: Option<&str>) -> Option<Url> {
    let base = configured
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_CODEX_BASE)
        .trim_end_matches('/');
    let base = base
        .strip_suffix("/codex/responses")
        .or_else(|| base.strip_suffix("/codex"))
        .unwrap_or(base);
    let url = Url::parse(&format!("{base}/wham/usage")).ok()?;
    matches!(url.scheme(), "https" | "http").then_some(url)
}

/// The Coding Plan key and quota URL of the registered `zai` models. They
/// must all use one API-key credential and one eligible endpoint.
fn zai_target<'a>(
    read: &'a ModelConfigurationRead,
    environment_base: Option<&str>,
) -> Result<(&'a str, Url), QuotaFetchError> {
    let configs: Vec<_> = read
        .registered
        .iter()
        .filter(|config| config.provider_id == "zai")
        .collect();
    let first = configs.first().ok_or(QuotaFetchError::NotConfigured)?;
    let mut target: Option<(&str, Url)> = None;
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
            .and_then(|id| read.credential_secret(id, "zai"))
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
