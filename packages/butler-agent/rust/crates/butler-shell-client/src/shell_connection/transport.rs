use crate::Error;
use reqwest::{Method, Response, Url};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{fmt, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Mutex;

/// The request header that carries the local admin credential (`APP_ADMIN_HEADER`).
const ADMIN_HEADER: &str = "x-butler-admin";

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
pub(crate) enum Body<'a> {
    None,
    Json(&'a Value),
    Bytes {
        content_type: &'a str,
        bytes: Vec<u8>,
    },
}
impl ShellClient {
    pub(crate) async fn download(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, String)],
    ) -> Result<crate::Download, Error> {
        let response = self
            .request(method, self.url(segments, query)?, &Body::None, false, None)
            .await?;
        Self::read_download(response).await
    }
    pub(crate) async fn read_download(response: Response) -> Result<crate::Download, Error> {
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned)
        };
        let content_type = header("content-type");
        let etag = header("etag");
        let bytes = response
            .bytes()
            .await
            .map_err(|_| Error::Connection)?
            .to_vec();
        Ok(crate::Download {
            content_type,
            etag,
            bytes,
        })
    }
    pub(crate) async fn upload(
        &self,
        segments: &[&str],
        query: &[(&str, String)],
        fields: &[(&str, &str)],
        file: &crate::Upload,
    ) -> Result<Value, Error> {
        let (content_type, bytes) = super::multipart::encode(fields, "file", file)?;
        self.bytes_json(segments, query, &content_type, bytes).await
    }
    pub(crate) async fn bytes_json(
        &self,
        segments: &[&str],
        query: &[(&str, String)],
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<Value, Error> {
        let response = self
            .request(
                Method::POST,
                self.url(segments, query)?,
                &Body::Bytes {
                    content_type,
                    bytes,
                },
                false,
                None,
            )
            .await?;
        let bytes = response.bytes().await.map_err(|_| Error::Connection)?;
        let raw: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
        raw.get("data").cloned().ok_or(Error::Protocol)
    }

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
        body: &Body<'_>,
        live: bool,
        admin: Option<&str>,
    ) -> Result<Response, Error> {
        // Only the message ingress dedupes client ids. Session creation and
        // authority side effects have no end-to-end retry guarantee.
        let idempotent = !matches!(body, Body::Bytes { .. })
            && (method == Method::GET
                || (method == Method::POST
                    && url.path() == "/messages"
                    && matches!(body, Body::Json(b) if b["client_message_id"].as_str().is_some())));
        let mut delay = Duration::from_millis(200);
        for attempt in 0..3 {
            let result = self
                .authenticated_request(method.clone(), url.clone(), body, live, admin)
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
        body: &Body<'_>,
        live: bool,
        admin: Option<&str>,
    ) -> Result<Response, Error> {
        let token = self.inner.token.lock().await.clone();
        let first = self
            .send(method.clone(), url.clone(), body, live, &token, admin)
            .await?;
        if first.status().as_u16() != 401 {
            return checked(first).await;
        }
        drop(first);
        if matches!(body, Body::Bytes { .. }) {
            return Err(Error::Authentication);
        }
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
        checked(self.send(method, url, body, live, &next, admin).await?).await
    }
    async fn send(
        &self,
        method: Method,
        url: Url,
        body: &Body<'_>,
        live: bool,
        token: &str,
        admin: Option<&str>,
    ) -> Result<Response, Error> {
        let mut request = self
            .inner
            .http
            .request(method, url)
            .phase(butler_log::http::Phase::current().sensitive())
            .bearer_auth(token);
        if let Some(admin) = admin {
            request = request.header(ADMIN_HEADER, admin);
        }
        if !live {
            request = request.timeout(Duration::from_secs(30));
        }
        request = match body {
            Body::None => request,
            Body::Json(value) => request.json(value),
            Body::Bytes {
                content_type,
                bytes,
            } => request
                .header("content-type", *content_type)
                .body(bytes.clone()),
        };
        request.send().await.map_err(|_| Error::Connection)
    }
    pub(crate) async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<T, Error> {
        self.json_as(method, segments, query, body, None).await
    }
    /// A request carrying the app's local admin credential (`x-butler-admin`), read on every call
    /// from `<data>/app/runtime/auth/local-admin.json` (schema "butler.app-local-admin.v1", field
    /// "secret", at least 32 visible ASCII). Missing or invalid: `Error::LocalMetadata`, React's
    /// `admin_credential_required` state. The credential is never logged.
    pub(crate) async fn admin_json<T: DeserializeOwned>(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<T, Error> {
        let data = self.inner.data.clone();
        let admin = tokio::task::spawn_blocking(move || super::attach::read_admin(&data))
            .await
            .map_err(|_| Error::LocalMetadata)??;
        self.json_as(method, segments, query, body, Some(&admin))
            .await
    }
    async fn json_as<T: DeserializeOwned>(
        &self,
        method: Method,
        segments: &[&str],
        query: &[(&str, String)],
        body: Option<&Value>,
        admin: Option<&str>,
    ) -> Result<T, Error> {
        let response = self
            .request(
                method,
                self.url(segments, query)?,
                &body.map_or(Body::None, Body::Json),
                false,
                admin,
            )
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
