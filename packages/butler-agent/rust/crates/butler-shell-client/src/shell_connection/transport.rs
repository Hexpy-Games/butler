use crate::Error;
use reqwest::{Method, Response, Url};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{fmt, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Mutex;

/// Cloneable authenticated local agent connection. Debug always redacts auth.
#[derive(Clone)]
pub struct ShellClient {
    pub(crate) inner: Arc<Inner>,
}
pub(crate) struct Inner {
    pub(crate) data: PathBuf,
    pub(crate) endpoint: Url,
    pub(crate) identity: (u32, String, String),
    pub(crate) http: butler_log::http::Client,
    token: Mutex<String>,
}
impl fmt::Debug for ShellClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ShellClient")
            .field("auth", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}
impl ShellClient {
    pub(crate) fn new(
        data: PathBuf,
        endpoint: Url,
        token: String,
        identity: (u32, String, String),
    ) -> Result<Self, Error> {
        let http = butler_log::http::loopback()
            .no_proxy()
            .redirect(butler_log::http::RedirectPolicy::none())
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| Error::Connection)?;
        Ok(Self {
            inner: Arc::new(Inner {
                data,
                endpoint,
                identity,
                http,
                token: Mutex::new(token),
            }),
        })
    }
    pub(crate) fn url(&self, segments: &[&str], query: &[(&str, String)]) -> Result<Url, Error> {
        let mut url = self.inner.endpoint.clone();
        url.path_segments_mut()
            .map_err(|()| Error::Protocol)?
            .clear()
            .extend(segments);
        url.query_pairs_mut()
            .extend_pairs(query.iter().map(|(k, v)| (*k, v)));
        Ok(url)
    }
    pub(crate) async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        live: bool,
    ) -> Result<Response, Error> {
        // Only the message ingress dedupes client ids. Session creation and
        // authority side effects have no end-to-end retry guarantee.
        let idempotent = method == Method::GET
            || (method == Method::POST
                && url.path() == "/messages"
                && body.and_then(|b| b["client_message_id"].as_str()).is_some());
        let mut delay = Duration::from_millis(200);
        for attempt in 0..3 {
            let result = self
                .authenticated_request(method.clone(), url.clone(), body, live)
                .await;
            if !idempotent
                || attempt == 2
                || !matches!(&result, Err(e) if e.kind() == crate::FailureKind::Retryable)
            {
                return result;
            }
            tokio::time::sleep(delay).await;
            delay *= 4;
        }
        Err(Error::Protocol)
    }
    async fn authenticated_request(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        live: bool,
    ) -> Result<Response, Error> {
        let token = self.inner.token.lock().await.clone();
        let first = self
            .send(method.clone(), url.clone(), body, live, &token)
            .await?;
        if first.status().as_u16() != 401 {
            return checked(first).await;
        }
        drop(first);
        // Serialize refreshes, and reuse a credential a concurrent 401 refreshed.
        let mut current = self.inner.token.lock().await;
        if *current == token {
            let data = self.inner.data.clone();
            if let Ok(Ok(next)) =
                tokio::task::spawn_blocking(move || super::attach::read_token(&data)).await
            {
                *current = next;
            }
        }
        let next = current.clone();
        drop(current);
        if next == token {
            return Err(Error::Authentication);
        }
        checked(self.send(method, url, body, live, &next).await?).await
    }
    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        live: bool,
        token: &str,
    ) -> Result<Response, Error> {
        let mut request = self
            .inner
            .http
            .request(method, url)
            .phase(butler_log::http::Phase::current().sensitive())
            .bearer_auth(token);
        if !live {
            request = request.timeout(Duration::from_secs(30));
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        request.send().await.map_err(|_| Error::Connection)
    }
    pub(crate) async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<T, Error> {
        let response = self
            .request(method, self.url(segments, query)?, body, false)
            .await?;
        #[derive(serde::Deserialize)]
        struct Envelope<T> {
            data: T,
        }
        let bytes = response.bytes().await.map_err(|_| Error::Connection)?;
        serde_json::from_slice::<Envelope<T>>(&bytes)
            .map(|e| e.data)
            .map_err(|_| Error::Protocol)
    }
}
async fn checked(response: Response) -> Result<Response, Error> {
    if response.status().is_success() {
        Ok(response)
    } else if response.status().as_u16() == 401 {
        Err(Error::Authentication)
    } else {
        let status = response.status().as_u16();
        if status == 404 {
            // The gateway distinguishes route errors from resource-specific codes.
            let bytes = response.bytes().await.map_err(|_| Error::Connection)?;
            let raw: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
            return match raw["error"]["code"].as_str() {
                Some("not_found") => Err(Error::Incompatible),
                Some(code) if code.ends_with("_not_found") => Err(Error::Http(404)),
                _ => Err(Error::Protocol),
            };
        }
        Err(Error::Http(status))
    }
}
