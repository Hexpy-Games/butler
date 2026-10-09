//! Loopback-only admin requests. Credentials and response bodies are never logged.
use crate::host::{
    cli::error::CliError,
    service::configuration::{AppServiceConfiguration, local_credentials::data_folder_token},
};
use reqwest::Method;
use serde_json::Value;
use std::{path::Path, time::Duration};

pub(super) struct Client {
    http: reqwest::Client,
    base: String,
    token: std::sync::Arc<str>,
    admin: String,
}

impl Client {
    pub(super) fn local(root: &Path) -> Result<Self, CliError> {
        let app = AppServiceConfiguration::capture(root);
        let gateway = app.gateway_config();
        Ok(Self {
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|_| unavailable())?,
            base: format!("http://127.0.0.1:{}", app.port),
            token: data_folder_token(root).ok_or_else(unavailable)?.into(),
            admin: gateway.admin_credential.clone().ok_or_else(unavailable)?,
        })
    }

    pub(super) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CliError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .header("X-Butler-Admin", &self.admin);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| unavailable())?;
        if !response.status().is_success() {
            // Do not echo a server body: reveal/rotate responses contain secrets.
            return Err(CliError::failed(
                "remote_request_failed",
                format!("Remote request refused (HTTP {}).", response.status()),
            ));
        }
        let body: Value = response.json().await.map_err(|_| {
            CliError::failed("remote_response_invalid", "Invalid security response.")
        })?;
        body.get("data").cloned().ok_or_else(|| {
            CliError::failed("remote_response_invalid", "Invalid security response.")
        })
    }
}

fn unavailable() -> CliError {
    CliError::failed(
        "service_not_running",
        "버틀러 서비스에 연결할 수 없습니다. butler start를 실행하세요. / Butler service is not running or unavailable. Run butler start.",
    )
}
