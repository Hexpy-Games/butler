//! HTTP only: the stdio process never opens BTCC or runs a second writer.
use super::*;
use crate::host::{cli::gateway::running_app_endpoint, service::configuration::data_folder_token};
use butler_canon::store::sanitize_mcp_client as sanitize;
use std::time::Duration;

pub(super) struct Client {
    http: butler_log::http::Client,
    base: String,
    token: String,
    title: String,
    name: String,
}
#[derive(Debug, serde::Serialize)]
pub(super) struct Error {
    pub(super) code: String,
    pub(super) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) current: Option<Value>,
}
impl Error {
    pub(super) fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            current: None,
        }
    }
    fn stopped() -> Self {
        Self::new("butler_not_running", "버틀러가 실행 중이 아닙니다")
    }
}
impl Client {
    pub(super) async fn local(
        server: &McpServer,
        context: &RequestContext<RoleServer>,
    ) -> Result<Self, Error> {
        let info = context
            .peer
            .peer_info()
            .ok_or_else(|| Error::new("permission", "Client identity required."))?;
        let name = sanitize(&info.client_info.name);
        let title = sanitize(
            info.client_info
                .title
                .as_deref()
                .unwrap_or(&info.client_info.name),
        );
        if name.is_empty() || title.is_empty() {
            return Err(Error::new("permission", "Client identity required."));
        }
        let base = running_app_endpoint(&server.data_root, &server.installation, Duration::ZERO)
            .await
            .map_err(|_| Error::stopped())?
            .ok_or_else(Error::stopped)?;
        let base = base.replace("http://0.0.0.0:", "http://127.0.0.1:");
        let url = reqwest::Url::parse(&base).map_err(|_| Error::stopped())?;
        if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
        {
            return Err(Error::stopped());
        }
        let data = server.data_root.clone();
        let token = tokio::task::spawn_blocking(move || data_folder_token(&data))
            .await
            .map_err(|_| Error::stopped())?
            .ok_or_else(Error::stopped)?;
        let http = butler_log::http::loopback()
            .timeout(Duration::from_secs(30))
            .redirect(butler_log::http::RedirectPolicy::none())
            .build()
            .map_err(|_| Error::stopped())?;
        Ok(Self {
            http,
            base,
            token,
            title,
            name,
        })
    }
    pub(super) async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, Error> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base.trim_end_matches('/')))
            .bearer_auth(&self.token)
            .header("X-Butler-Delegate-Client", &self.title)
            .header("X-Butler-Delegate-Client-Name", &self.name);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| Error::stopped())?;
        let status = response.status();
        let data: Value = response.json().await.map_err(|_| Error::stopped())?;
        if !status.is_success() {
            return Err(Error {
                code: data
                    .pointer("/error/code")
                    .and_then(Value::as_str)
                    .unwrap_or("permission")
                    .into(),
                message: data
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("요청을 확인해 주세요.")
                    .into(),
                current: data
                    .pointer("/error/current/revision")
                    .map(|r| json!({"revision":r})),
            });
        }
        data.get("data").cloned().ok_or_else(Error::stopped)
    }
    pub(super) async fn get(&self, path: &str) -> Result<Value, Error> {
        self.request(reqwest::Method::GET, path, None).await
    }
}
pub(super) fn component(value: &str) -> String {
    // Form encoding uses + for spaces; a URL path segment requires %20.
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
