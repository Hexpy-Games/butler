//! Main-only authenticated transport, with credentials never in result JSON.
use super::super::GuidedTools;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub(super) struct Client {
    client: reqwest::Client,
    base: String,
    bearer: String,
    admin: String,
    pub session: String,
}
impl Client {
    pub(super) async fn new(owner: &GuidedTools) -> Option<Self> {
        let endpoint = owner.app_endpoint.snapshot()?;
        let data = owner.binding.butler_data.clone();
        let admin = tokio::task::spawn_blocking(move || {
            let file = butler_platform::secure_fs::open_read_no_follow(
                &data.join("app/runtime/auth/local-admin.json"),
            )?;
            serde_json::from_reader::<_, Value>(file).map_err(std::io::Error::other)
        })
        .await
        .ok()?
        .ok()?;
        Some(Self {
            client: reqwest::Client::new(),
            base: endpoint.base_url,
            bearer: endpoint.local_auth.token()?.to_string(),
            admin: admin["secret"].as_str()?.into(),
            session: owner
                .binding
                .app_session_id
                .clone()
                .unwrap_or_else(|| owner.binding.source_session_id.clone()),
        })
    }
    pub(super) async fn waiting(&self, tab: &Value, value: bool, signal: &CancellationToken) {
        self.call("tab.waiting", tab, &json!({"value":value}), signal)
            .await;
    }
    pub(super) async fn call(
        &self,
        op: &str,
        tab: &Value,
        args: &Value,
        signal: &CancellationToken,
    ) -> Value {
        let call_id = uuid::Uuid::new_v4().to_string();
        let request = self
            .client
            .post(format!("{}/internal/browser/calls", self.base))
            .bearer_auth(&self.bearer)
            .header("x-butler-admin", &self.admin)
            .json(&json!({"op":op,"session":self.session,"tab":tab,"args":args,"call_id":call_id}))
            .timeout(std::time::Duration::from_secs(31))
            .send();
        let result = tokio::select! {
            ()=signal.cancelled()=>{
                let _ = self.client.post(format!("{}/internal/browser/calls",self.base))
                    .bearer_auth(&self.bearer).header("x-butler-admin",&self.admin)
                    .json(&json!({"op":"tab.cancel","session":self.session,"tab":tab,"args":{"call_id":call_id}}))
                    .timeout(std::time::Duration::from_secs(2)).send().await;
                json!({"status":"unknown","reason":"cancelled"})
            },
            result=request=>match result {
                Ok(response) if response.status().is_success()=>response.json::<Value>().await.unwrap_or_else(|_|json!({"status":"unknown","reason":"invalid_result"})),
                Ok(response) if response.status().is_server_error()=>json!({"status":"unknown","reason":"browser_result_unknown"}),
                Ok(_)=>json!({"status":"not_dispatched","reason":"browser_refused"}),
                Err(_)=>json!({"status":"unknown","reason":"browser_host_lost"}),
            }
        };
        let count = if op == "tab.act" {
            args["steps"].as_array().map_or(0, Vec::len)
        } else {
            0
        };
        butler_runtime::browser::batch_receipts(count, result)
    }
}
