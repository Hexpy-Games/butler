//! On-demand Butler account operations against butler-cloud.
use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};

use butler_gateway::gateway::{ButlerAccountRequest, GatewayApplicationError};
use butler_log::http::{Client, Phase, Purpose, RedirectPolicy};
use butler_platform::secure_fs;
use butler_turn::btcc::BtccError;
use reqwest::{Method, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::host::build_info::dev_build;

const DEFAULT_API_URL: &str = "https://api.butler.hexpy.games";
const DEV_API_URL: &str = "https://butler-cloud-api-dev.hexpy-dev.workers.dev";

pub(crate) struct ButlerAccount {
    http: Client,
    pub(super) base_url: String,
    pub(super) data: PathBuf,
    pub(super) uploads: Client,
    file: PathBuf,
}

#[derive(Deserialize, Serialize)]
pub(super) struct StoredAccount {
    schema_version: u32,
    api_url: String,
    pub(super) device_token: String,
    account_id: String,
    pub(super) device_id: String,
}

impl ButlerAccount {
    pub(crate) fn new(data_root: &Path) -> Result<Self, BtccError> {
        let base_url = std::env::var("BUTLER_CLOUD_API_URL")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                if dev_build() {
                    DEV_API_URL.to_owned()
                } else {
                    DEFAULT_API_URL.to_owned()
                }
            })
            .trim_end_matches('/')
            .to_owned();
        let client = |timeout| {
            butler_log::http::external(Purpose::new("butler-cloud"))
                .timeout(Duration::from_secs(timeout))
                .connect_timeout(Duration::from_secs(5))
                .redirect(RedirectPolicy::none())
                .build()
                .map_err(|_| {
                    BtccError::relayed(
                        "cloud_unavailable",
                        "The Butler service could not be reached.",
                    )
                })
        };
        Ok(Self {
            http: client(10)?,
            uploads: client(60)?,
            data: data_root.to_owned(),
            base_url,
            file: data_root.join("auth/butler-account.json"),
        })
    }

    pub(crate) async fn handle(
        &self,
        request: ButlerAccountRequest,
    ) -> Result<Value, GatewayApplicationError> {
        match request {
            ButlerAccountRequest::Status => self.status(None).await,
            ButlerAccountRequest::Start { email } => {
                let response = self
                    .send(
                        Method::POST,
                        "/v1/auth/email/start",
                        None,
                        Some(json!({"email": email})),
                    )
                    .await?;
                let value: Value = check(response, 202)
                    .await?
                    .json()
                    .await
                    .unwrap_or(Value::Null);
                match value["dev_code"].as_str() {
                    Some(code) => Ok(json!({"sent": true, "dev_code": code})),
                    None => Ok(json!({"sent": true})),
                }
            }
            ButlerAccountRequest::Verify { email, code } => self.verify(email, code).await,
            ButlerAccountRequest::DevPlan { plan } => self.status(Some(plan)).await,
            ButlerAccountRequest::SignOut => {
                if let Some(stored) = self.read().await? {
                    let response = self
                        .send(
                            Method::POST,
                            "/v1/auth/sign-out",
                            Some(&stored.device_token),
                            None,
                        )
                        .await?;
                    if response.status().as_u16() != 401 {
                        check(response, 204).await?;
                    }
                    self.delete().await?;
                }
                Ok(json!({"signed_in": false}))
            }
            ButlerAccountRequest::Devices | ButlerAccountRequest::RevokeDevice { .. } => {
                self.devices(request).await
            }
            ButlerAccountRequest::PushAvailable => {
                Ok(json!({"available": self.read().await?.is_some()}))
            }
            ButlerAccountRequest::PushTokens { tokens } => self.push_tokens(tokens).await,
            ButlerAccountRequest::Push { messages, tokens } => self.push(messages, tokens).await,
        }
    }

    async fn devices(
        &self,
        request: ButlerAccountRequest,
    ) -> Result<Value, GatewayApplicationError> {
        let stored = self.read().await?.ok_or_else(signed_out)?;
        let (method, path, expected) = match request {
            ButlerAccountRequest::RevokeDevice { id } => {
                let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
                let path = format!("/v1/devices/{}", encoded.replace('+', "%20"));
                (Method::DELETE, path, 204)
            }
            _ => (Method::GET, "/v1/devices".to_owned(), 200),
        };
        let response = self
            .send(method, &path, Some(&stored.device_token), None)
            .await?;
        if response.status().as_u16() == 401 {
            self.delete().await?;
            return Err(signed_out());
        }
        let response = check(response, expected).await?;
        if expected == 204 {
            Ok(json!({"revoked": true}))
        } else {
            response.json().await.map_err(|_| unavailable())
        }
    }

    async fn status(&self, plan: Option<String>) -> Result<Value, GatewayApplicationError> {
        let Some(stored) = self.read().await? else {
            return Ok(json!({"signed_in": false}));
        };
        let (method, path, body) = match plan {
            Some(plan) => (Method::POST, "/v1/dev/plan", Some(json!({"plan": plan}))),
            None => (Method::GET, "/v1/me", None),
        };
        let response = self
            .send(method, path, Some(&stored.device_token), body)
            .await?;
        if response.status().as_u16() == 401 {
            self.delete().await?;
            return Ok(json!({"signed_in": false}));
        }
        let value: Value = check(response, 200)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        let mut status = json!({"signed_in": true, "account": value["account"],
            "device": value["device"], "entitlements": value["entitlements"]});
        if let Some(dev) = value.get("dev") {
            status["dev"] = dev.clone();
        }
        Ok(status)
    }

    async fn verify(&self, email: String, code: String) -> Result<Value, GatewayApplicationError> {
        let name = butler_platform::instance::host_name().unwrap_or_else(|_| "Butler".to_owned());
        let platform = butler_platform::instance::os_name();
        let response = self.send(Method::POST, "/v1/auth/email/verify", None,
            Some(json!({"email": email, "code": code, "device": {"name": name, "platform": platform}}))).await?;
        let value: Value = check(response, 200)
            .await?
            .json()
            .await
            .map_err(|_| unavailable())?;
        let stored = StoredAccount {
            schema_version: 1,
            api_url: self.base_url.clone(),
            device_token: value["device_token"]
                .as_str()
                .ok_or_else(unavailable)?
                .to_owned(),
            account_id: value["account"]["id"]
                .as_str()
                .ok_or_else(unavailable)?
                .to_owned(),
            device_id: value["device"]["id"]
                .as_str()
                .ok_or_else(unavailable)?
                .to_owned(),
        };
        let file = self.file.clone();
        tokio::task::spawn_blocking(move || {
            let parent = file
                .parent()
                .ok_or_else(GatewayApplicationError::internal)?;
            secure_fs::create_private_dir_all(parent)
                .map_err(GatewayApplicationError::internal_from)?;
            secure_fs::replace_private(
                &file,
                |writer| {
                    serde_json::to_writer(writer, &stored)
                        .map_err(GatewayApplicationError::internal_from)
                },
                GatewayApplicationError::internal_from,
            )
        })
        .await
        .map_err(GatewayApplicationError::internal_from)??;
        self.status(None).await
    }

    pub(crate) async fn device_token(&self) -> Result<Option<String>, GatewayApplicationError> {
        Ok(self.read().await?.map(|stored| stored.device_token))
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.base_url
    }

    pub(super) async fn read(&self) -> Result<Option<StoredAccount>, GatewayApplicationError> {
        let file = self.file.clone();
        let base_url = self.base_url.clone();
        tokio::task::spawn_blocking(move || {
            let bytes = match std::fs::read(file) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(GatewayApplicationError::internal_from(error)),
            };
            let stored: StoredAccount =
                serde_json::from_slice(&bytes).map_err(GatewayApplicationError::internal_from)?;
            Ok((stored.api_url == base_url).then_some(stored))
        })
        .await
        .map_err(GatewayApplicationError::internal_from)?
    }

    pub(crate) async fn delete(&self) -> Result<(), GatewayApplicationError> {
        match tokio::fs::remove_file(&self.file).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(GatewayApplicationError::internal_from(error)),
        }
    }

    pub(super) async fn send(
        &self,
        method: Method,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Response, GatewayApplicationError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base_url))
            .phase(Phase::current().sensitive());
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        request.send().await.map_err(|_| unavailable())
    }
}

pub(super) async fn check(
    response: Response,
    expected: u16,
) -> Result<Response, GatewayApplicationError> {
    let status = response.status().as_u16();
    if status == expected {
        return Ok(response);
    }
    let value: Value = response.json().await.unwrap_or(Value::Null);
    Err(GatewayApplicationError::Public {
        status,
        code: value["error"]["code"]
            .as_str()
            .unwrap_or("cloud_error")
            .into(),
        message: value["error"]["message"]
            .as_str()
            .unwrap_or("The Butler service did not answer as expected.")
            .into(),
        source: None,
    })
}

pub(super) fn unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 502,
        code: "cloud_unavailable".into(),
        message: "The Butler service could not be reached.".into(),
        source: None,
    }
}

pub(super) fn signed_out() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 401,
        code: "butler_account_signed_out".into(),
        message: "Sign in to your Butler account first.".into(),
        source: None,
    }
}
