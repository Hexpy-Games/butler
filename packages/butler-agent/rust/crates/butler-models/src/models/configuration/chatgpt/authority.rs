//! Lazy, bounded discovery and JWKS. No inference or idle work uses this cache.
use super::{DEFAULT_ISSUER, Error};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const TTL: Duration = Duration::from_hours(24);
const BODY_LIMIT: usize = 256 * 1024;

#[derive(Clone, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub revocation_endpoint: String,
    pub jwks_uri: String,
}
struct Cached {
    discovery: Discovery,
    keys: Vec<Value>,
    loaded: Instant,
}
pub struct ChatGptAuthority {
    issuer: String,
    cache: Mutex<Option<Cached>>,
}

impl ChatGptAuthority {
    pub fn new(issuer: Option<&str>) -> Self {
        Self {
            issuer: issuer
                .unwrap_or(DEFAULT_ISSUER)
                .trim_end_matches('/')
                .into(),
            cache: Mutex::new(None),
        }
    }
    pub fn client(&self) -> Result<reqwest::Client, Error> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "oauth_discovery_unavailable")
    }
    pub async fn discovery(&self) -> Result<Discovery, Error> {
        let mut cache = self.cache.lock().await;
        if let Some(cached) = cache.as_ref().filter(|c| c.loaded.elapsed() < TTL) {
            return Ok(cached.discovery.clone());
        }
        validate_url(&self.issuer, &self.issuer)?;
        let raw = bounded_json(
            self.client()?
                .get(format!("{}/.well-known/openid-configuration", self.issuer))
                .send()
                .await,
        )
        .await
        .map_err(|_| "oauth_discovery_unavailable")?;
        let discovery: Discovery =
            serde_json::from_value(raw).map_err(|_| "oauth_discovery_unavailable")?;
        if discovery.issuer.trim_end_matches('/') != self.issuer {
            return Err("oauth_discovery_unavailable");
        }
        for endpoint in [
            &discovery.authorization_endpoint,
            &discovery.token_endpoint,
            &discovery.revocation_endpoint,
            &discovery.jwks_uri,
        ] {
            validate_url(endpoint, &self.issuer)?;
        }
        let keys = self.fetch_keys(&discovery.jwks_uri).await?;
        *cache = Some(Cached {
            discovery: discovery.clone(),
            keys,
            loaded: Instant::now(),
        });
        Ok(discovery)
    }
    async fn fetch_keys(&self, uri: &str) -> Result<Vec<Value>, Error> {
        let raw = bounded_json(self.client()?.get(uri).send().await)
            .await
            .map_err(|_| "oauth_discovery_unavailable")?;
        raw["keys"]
            .as_array()
            .cloned()
            .ok_or("oauth_discovery_unavailable")
    }
    /// Called once during ID-token validation: an unknown kid permits one refetch.
    pub async fn key(&self, discovery: &Discovery, kid: &str) -> Result<Value, Error> {
        let mut cache = self.cache.lock().await;
        if let Some(key) = cache.as_ref().and_then(|c| select(&c.keys, kid)) {
            return Ok(key);
        }
        let keys = self
            .fetch_keys(&discovery.jwks_uri)
            .await
            .map_err(|_| "oauth_id_token_invalid")?;
        let key = select(&keys, kid);
        if let Some(cached) = cache.as_mut() {
            cached.keys = keys;
        }
        key.ok_or("oauth_id_token_invalid")
    }
}
fn select(keys: &[Value], kid: &str) -> Option<Value> {
    keys.iter()
        .find(|key| {
            key["kid"] == kid
                && key["kty"] == "RSA"
                && key.get("use").is_none_or(|usage| usage == "sig")
                && key.get("alg").is_none_or(|algorithm| algorithm == "RS256")
        })
        .cloned()
}
fn loopback(url: &url::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}
fn validate_url(value: &str, issuer: &str) -> Result<(), Error> {
    let url = url::Url::parse(value).map_err(|_| "oauth_discovery_unavailable")?;
    let issuer = url::Url::parse(issuer).map_err(|_| "oauth_discovery_unavailable")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && issuer.scheme() == "http"
                && loopback(&issuer)
                && loopback(&url)))
    {
        return Err("oauth_discovery_unavailable");
    }
    Ok(())
}

pub async fn bounded_json(
    response: Result<reqwest::Response, reqwest::Error>,
) -> Result<Value, Error> {
    let mut response = response.map_err(|_| "oauth_exchange_failed")?;
    if !response.status().is_success() {
        return Err("oauth_exchange_failed");
    }
    response_value(&mut response).await
}
pub async fn response_value(response: &mut reqwest::Response) -> Result<Value, Error> {
    if response
        .content_length()
        .is_some_and(|len| len > BODY_LIMIT as u64)
    {
        return Err("oauth_exchange_failed");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "oauth_exchange_failed")?
    {
        if bytes.len() + chunk.len() > BODY_LIMIT {
            return Err("oauth_exchange_failed");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "oauth_exchange_failed")
}
