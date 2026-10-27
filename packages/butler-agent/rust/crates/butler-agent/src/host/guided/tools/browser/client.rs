//! Main-only authenticated transport, with credentials never in result JSON.
use super::super::GuidedTools;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub(in crate::host::guided::tools) struct Client {
    client: butler_log::http::Client,
    base: String,
    bearer: String,
    admin: String,
    pub session: String,
    pub approval_handoff: bool,
    turn: String,
    schedule_browser: Option<butler_turn::btcc::ScheduleBrowserOptions>,
}
impl Client {
    pub(in crate::host::guided::tools) async fn vision(&self, model: &str) -> bool {
        super::super::outputs::vision(&self.client, &self.base, &self.bearer, model).await
    }
    pub(in crate::host::guided::tools) async fn new(owner: &GuidedTools) -> Option<Self> {
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
        // Reuse only transport: endpoint, credentials and tab ownership are
        // freshly resolved above/on every call. Trust-store loading is blocking.
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
            approval_handoff: false,
            schedule_browser: owner.schedule_run().and_then(|run| run.browser),
            client,
            turn: owner.binding.turn_id.clone(),
            base: endpoint.base_url,
            bearer: endpoint.local_auth.token()?.to_string(),
            admin: admin["secret"].as_str()?.into(),
            session: owner
                .subsessions
                .browser_owner(&owner.binding.source_session_id)
                .await
                .ok()??,
        })
    }
    pub(in crate::host::guided::tools) async fn waiting(
        &self,
        tab: &Value,
        value: bool,
        signal: &CancellationToken,
    ) {
        self.call("tab.waiting", tab, &json!({"value":value}), signal)
            .await;
    }
    pub(in crate::host::guided::tools) async fn call(
        &self,
        op: &str,
        tab: &Value,
        args: &Value,
        signal: &CancellationToken,
    ) -> Value {
        let call_id = uuid::Uuid::new_v4().to_string();
        let request = self
            .client
            .post(format!("{}{}", self.base, if op.starts_with("images.") {"/internal/images/calls"} else {"/internal/browser/calls"}))
            .bearer_auth(&self.bearer)
            .header("x-butler-admin", &self.admin)
            .json(&json!({"op":op,"session":self.session,"tab":tab,"args":args,"call_id":call_id,"turn_id":self.turn,"schedule_browser":self.schedule_browser}))
            .timeout(std::time::Duration::from_secs(31))
            .send();
        let request = async {
            match request.await {
                Ok(response) if response.status().is_success() => response
                    .json::<Value>()
                    .await
                    .unwrap_or_else(|_| json!({"status":"unknown","reason":"invalid_result"})),
                Ok(response) if response.status().is_server_error() => {
                    json!({"status":"unknown","reason":"browser_result_unknown"})
                }
                Ok(_) => json!({"status":"not_dispatched","reason":"browser_refused"}),
                Err(_) => json!({"status":"unknown","reason":"browser_host_lost"}),
            }
        };
        let mut result = tokio::select! {
            ()=signal.cancelled()=>{
                let _ = self.client.post(format!("{}/internal/browser/calls",self.base))
                    .bearer_auth(&self.bearer).header("x-butler-admin",&self.admin)
                    .json(&json!({"op":"tab.cancel","session":self.session,"tab":tab,"args":{"call_id":call_id}}))
                    .timeout(std::time::Duration::from_secs(2)).send().await;
                json!({"status":"unknown","reason":"cancelled"})
            },
            result=request=>result
        };
        // Internal phase timings stop at the model-facing transport boundary.
        if let Some(record) = result.as_object_mut() {
            record.remove("settleMs");
        }
        let count = if op == "tab.act" {
            args["steps"].as_array().map_or(0, Vec::len)
        } else {
            0
        };
        butler_runtime::browser::batch_receipts(count, result)
    }
}
