//! One GET of a provider usage endpoint: bounded time and body, no
//! redirects (a credential never follows one), and one IPv4-only retry when
//! the first connection attempt fails (hosts with a broken IPv6 route).

use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

use reqwest::header::{HeaderMap, RETRY_AFTER};
use reqwest::{Client, Response, Url, redirect::Policy};

const TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_BODY_BYTES: usize = 64 * 1024;
/// The longest `Retry-After` honoured.
const MAX_RETRY_AFTER_SECONDS: i64 = 60 * 60;

/// How a provider bills when it offers no quota to read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuotaBilling {
    /// Pay-per-token API billing.
    Api,
    /// A subscription plan whose quota has no documented read surface.
    Subscription,
    /// Not known (local and custom models).
    Unknown,
}

/// Why a quota poll produced no reading. It carries no response bodies,
/// headers or credentials, so it is safe to log by [`QuotaFetchError::code`].
#[derive(Debug, thiserror::Error)]
pub enum QuotaFetchError {
    /// The provider (or its configured endpoint) offers no quota to read.
    #[error("the provider offers no quota to read")]
    NotOffered(QuotaBilling),
    /// No credential that can read the provider's quota is configured.
    #[error("no credential can read the provider's quota")]
    NotConfigured,
    /// The login could not be resolved or refreshed.
    #[error("the provider login could not be resolved")]
    AuthUnavailable,
    /// The model configuration could not be read.
    #[error("the model configuration could not be read")]
    Configuration,
    /// The provider rejected the credential (HTTP 401, or the provider's
    /// own code for an in-body rejection). A 403 is not a rejection: it is
    /// often an edge block, and a login refresh would not help.
    #[error("the provider rejected the credential (code {status})")]
    Unauthorized {
        /// 401, or the provider's own rejection code.
        status: u16,
    },
    /// The provider rate-limited the read.
    #[error("the provider rate-limited the quota read")]
    RateLimited {
        /// `Retry-After`, in milliseconds, when the provider sent one.
        retry_after_ms: Option<i64>,
    },
    /// Any other unsuccessful HTTP status.
    #[error("the quota endpoint answered HTTP {status}")]
    Http {
        /// HTTP status.
        status: u16,
    },
    /// The provider answered in its envelope that the read failed.
    #[error("the provider refused the quota read")]
    Refused,
    /// The request did not complete.
    #[error("the quota request failed")]
    Transport(#[source] reqwest::Error),
    /// The body was not the expected JSON (or exceeded the size limit).
    #[error("the quota response did not match the expected schema")]
    Schema,
}

impl QuotaFetchError {
    /// A short stable code for logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotOffered(_) => "not_offered",
            Self::NotConfigured => "not_configured",
            Self::AuthUnavailable => "auth_unavailable",
            Self::Configuration => "configuration_unreadable",
            Self::Unauthorized { .. } => "unauthorized",
            Self::RateLimited { .. } => "rate_limited",
            Self::Http { .. } => "http_status",
            Self::Refused => "refused",
            Self::Transport(error) if error.is_timeout() => "timeout",
            Self::Transport(_) => "transport",
            Self::Schema => "schema_mismatch",
        }
    }
}

/// One quota poll's result, and whether it refreshed the provider login
/// (after a rejected token) on the way.
#[derive(Debug)]
pub struct QuotaFetch {
    /// The reading, or why there is none.
    pub result: Result<super::ProviderQuotaReading, QuotaFetchError>,
    /// A login refresh was attempted after an HTTP 401.
    pub refreshed_login: bool,
}

impl From<Result<super::ProviderQuotaReading, QuotaFetchError>> for QuotaFetch {
    fn from(result: Result<super::ProviderQuotaReading, QuotaFetchError>) -> Self {
        Self {
            result,
            refreshed_login: false,
        }
    }
}

/// HTTP clients for quota polls and the User-Agent they send (Butler's own).
#[derive(Clone)]
pub struct QuotaHttp {
    client: Client,
    ipv4: Client,
    user_agent: String,
}

impl QuotaHttp {
    /// Builds the default and the IPv4-only client.
    pub fn new(user_agent: impl Into<String>) -> Result<Self, reqwest::Error> {
        let builder = || {
            Client::builder()
                .redirect(Policy::none())
                .timeout(TIMEOUT)
                .connect_timeout(CONNECT_TIMEOUT)
        };
        Ok(Self {
            client: builder().build()?,
            ipv4: builder()
                .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
                .build()?,
            user_agent: user_agent.into(),
        })
    }

    /// The User-Agent every quota request sends.
    pub fn user_agent(&self) -> &str {
        &self.user_agent
    }

    /// GETs `url` and returns the successful body.
    pub(crate) async fn get(
        &self,
        url: &Url,
        headers: &HeaderMap,
    ) -> Result<Vec<u8>, QuotaFetchError> {
        let response = match send(&self.client, url, headers).await {
            Err(error) if error.is_connect() => send(&self.ipv4, url, headers).await,
            result => result,
        }
        .map_err(QuotaFetchError::Transport)?;
        body(response).await
    }
}

async fn send(client: &Client, url: &Url, headers: &HeaderMap) -> Result<Response, reqwest::Error> {
    client
        .get(url.clone())
        .headers(headers.clone())
        .send()
        .await
}

/// The body of a successful response, or the status as an error.
async fn body(mut response: Response) -> Result<Vec<u8>, QuotaFetchError> {
    let status = response.status().as_u16();
    match status {
        200..=299 => {}
        401 => return Err(QuotaFetchError::Unauthorized { status }),
        429 => {
            return Err(QuotaFetchError::RateLimited {
                retry_after_ms: retry_after_ms(response.headers()),
            });
        }
        _ => return Err(QuotaFetchError::Http { status }),
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(QuotaFetchError::Transport)? {
        if bytes.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(QuotaFetchError::Schema);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// `Retry-After` in whole seconds, at most an hour (the HTTP-date form is
/// ignored).
fn retry_after_ms(headers: &HeaderMap) -> Option<i64> {
    let seconds = headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<i64>()
        .ok()?;
    (seconds >= 0).then(|| seconds.min(MAX_RETRY_AFTER_SECONDS).saturating_mul(1000))
}
