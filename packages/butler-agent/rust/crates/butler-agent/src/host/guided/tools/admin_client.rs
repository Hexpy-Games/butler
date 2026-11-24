//! Main-only authenticated app transport.
use super::GuidedTools;
use butler_log::http::{Client, RequestBuilder};
use reqwest::Method;
use serde_json::{Value, json};

#[derive(Clone)]
pub(super) struct AdminClient {
    pub(super) client: Client,
    pub(super) base: String,
    pub(super) bearer: String,
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
        let client = owner
            .browser_http
            .get_or_try_init(|| async {
                tokio::task::spawn_blocking(|| butler_log::http::loopback().build())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .ok_or(())
            })
            .await
            .ok()?
            .clone();
        Some(Self {
            client,
            base: endpoint.base_url,
            bearer: endpoint.local_auth.token()?.to_string(),
            admin: admin["secret"].as_str()?.into(),
        })
    }

    pub(super) fn request(&self, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.bearer)
            .header("x-butler-admin", &self.admin)
    }

    pub(super) async fn data(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Value> {
        let unavailable = || json!({"code":"gateway_unavailable","message":"Could not reach the Butler gateway."});
        let request = self.request(method, path);
        let request = if let Some(body) = body {
            request.json(body)
        } else {
            request
        };
        let response = request.send().await.map_err(|_| unavailable())?;
        let success = response.status().is_success();
        let mut envelope = response.json::<Value>().await.map_err(|_| unavailable())?;
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
