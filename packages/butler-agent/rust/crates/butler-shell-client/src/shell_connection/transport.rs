// Local authenticated gateway IPC; this is not runtime/model HTTP egress.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "UI-independent loopback gateway transport; credentials must not enter runtime HTTP logs"
)]
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
    pub(crate) http: reqwest::Client,
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
    pub(crate) fn new(data: PathBuf, endpoint: Url, token: String) -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| Error::Connection)?;
        Ok(Self {
            inner: Arc::new(Inner {
                data,
                endpoint,
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
        let token = self.inner.token.lock().await.clone();
        let first = self
            .send(method.clone(), url.clone(), body, live, &token)
            .await?;
        if first.status().as_u16() != 401 {
            return checked(first);
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
        checked(self.send(method, url, body, live, &next).await?)
    }
    async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        live: bool,
        token: &str,
    ) -> Result<Response, Error> {
        let mut request = self.inner.http.request(method, url).bearer_auth(token);
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
        response
            .json::<Envelope<T>>()
            .await
            .map(|e| e.data)
            .map_err(|_| Error::Protocol)
    }
}
fn checked(response: Response) -> Result<Response, Error> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(Error::Http(response.status().as_u16()))
    }
}
