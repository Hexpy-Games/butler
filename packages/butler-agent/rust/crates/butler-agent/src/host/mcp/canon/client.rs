//! HTTP only: the stdio process never opens BTCC or runs a second writer.
use super::*;
use crate::host::{
    cli::{
        gateway::{AppEndpoint, running_app_endpoint},
        remote_relay::socket_request,
    },
    service::configuration::data_folder_token,
};
use butler_canon::store::sanitize_mcp_client as sanitize;
use std::time::Duration;

pub(super) struct Client {
    http: butler_log::http::Client,
    endpoint: AppEndpoint,
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
            .map(|info| info.client_info.clone())
            .or_else(|| context.meta.client_info())
            .ok_or_else(|| Error::new("permission", "Client identity required."))?;
        let name = sanitize(&info.name);
        let title = sanitize(info.title.as_deref().unwrap_or(&info.name));
        if name.is_empty() || title.is_empty() {
            return Err(Error::new("permission", "Client identity required."));
        }
        let mut endpoint =
            running_app_endpoint(&server.data_root, &server.installation, Duration::ZERO)
                .await
                .map_err(|_| Error::stopped())?
                .ok_or_else(Error::stopped)?;
        if let AppEndpoint::Tcp(base) = &mut endpoint {
            *base = base.replace("http://0.0.0.0:", "http://127.0.0.1:");
            let url = reqwest::Url::parse(base).map_err(|_| Error::stopped())?;
            if url.scheme() != "http"
                || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"))
            {
                return Err(Error::stopped());
            }
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
            endpoint,
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
        let headers = [
            ("X-Butler-Delegate-Client", self.title.as_str()),
            ("X-Butler-Delegate-Client-Name", self.name.as_str()),
        ];
        let (status, data): (u16, Value) = match &self.endpoint {
            AppEndpoint::Tcp(base) => {
                let mut request = self
                    .http
                    .request(method, format!("{}{path}", base.trim_end_matches('/')))
                    .bearer_auth(&self.token);
                for (name, value) in headers {
                    request = request.header(name, value);
                }
                if let Some(body) = body {
                    request = request.json(&body);
                }
                let response = request.send().await.map_err(|_| Error::stopped())?;
                let status = response.status().as_u16();
                (status, response.json().await.map_err(|_| Error::stopped())?)
            }
            AppEndpoint::Remote(socket) => {
                let body = body.map(|body| body.to_string()).unwrap_or_default();
                let reply = socket_request(
                    socket,
                    method.as_str(),
                    path,
                    &self.token,
                    None,
                    &headers,
                    body.as_bytes(),
                )
                .await
                .map_err(|_| Error::stopped())?;
                let status = reply["status"]
                    .as_u64()
                    .and_then(|status| u16::try_from(status).ok())
                    .ok_or_else(Error::stopped)?;
                (status, reply["body"].clone())
            }
        };
        if !(200..300).contains(&status) {
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
