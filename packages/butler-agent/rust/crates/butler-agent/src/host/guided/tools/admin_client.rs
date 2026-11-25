//! Main-only authenticated app transport.
use super::GuidedTools;
use crate::host::{
    ActiveAppEndpoint,
    app::self_api::{SelfApi, SelfApiError, SelfResponse},
};
use http::Method;
use serde_json::{Value, json};
use tokio::time::Instant;

#[derive(Clone)]
pub(super) struct AdminClient {
    pub(super) endpoint: std::sync::Arc<ActiveAppEndpoint>,
    admin: String,
}

impl AdminClient {
    pub(super) async fn new(owner: &GuidedTools) -> Option<Self> {
        let endpoint = owner.app_endpoint.snapshot()?;
        let path = owner
            .binding
            .butler_data
            .join(butler_platform::data_paths::LOCAL_ADMIN);
        let admin = tokio::task::spawn_blocking(move || {
            let file = butler_platform::secure_fs::open_read_no_follow(&path)?;
            serde_json::from_reader::<_, Value>(file).map_err(std::io::Error::other)
        })
        .await
        .ok()?
        .ok()?;
        endpoint.local_auth.token()?;
        Some(Self {
            endpoint: owner.app_endpoint.clone(),
            admin: admin["secret"].as_str()?.into(),
        })
    }

    pub(super) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        deadline: Option<Instant>,
    ) -> Result<SelfResponse, SelfApiError> {
        SelfApi::new(&self.endpoint)
            .request(method, path, body, Some(&self.admin), deadline)
            .await
    }

    pub(super) async fn data(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Value> {
        let unavailable = || json!({"code":"gateway_unavailable","message":"Could not reach the Butler gateway."});
        let response = self
            .request(method, path, body, None)
            .await
            .map_err(|_| unavailable())?;
        let success = response.status().is_success();
        let bytes = response.bytes().await.map_err(|_| unavailable())?;
        let mut envelope: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if success {
            Ok(envelope["data"].take())
        } else {
            let error = &envelope["error"];
            if error["code"].is_string() && error["message"].is_string() {
                Err(json!({"code":error["code"],"message":error["message"]}))
            } else {
                Err(unavailable())
            }
        }
    }
}
