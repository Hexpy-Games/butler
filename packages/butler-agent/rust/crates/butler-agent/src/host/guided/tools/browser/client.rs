//! Main-only authenticated transport, with credentials never in result JSON.
use super::super::{GuidedTools, admin_client::AdminClient};
use http::Method;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub(in crate::host::guided::tools) struct Client {
    admin: AdminClient,
    pub session: String,
    pub approval_handoff: bool,
    turn: String,
    schedule_browser: Option<butler_turn::btcc::ScheduleBrowserOptions>,
}
impl Client {
    pub(in crate::host::guided::tools) async fn vision(&self, model: &str) -> bool {
        super::super::outputs::vision(&self.admin.endpoint, model).await
    }
    pub(in crate::host::guided::tools) async fn new(owner: &GuidedTools) -> Option<Self> {
        let admin = AdminClient::new(owner).await?;
        Some(Self {
            approval_handoff: false,
            schedule_browser: owner.schedule_run().and_then(|run| run.browser),
            turn: owner.binding.turn_id.clone(),
            admin,
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
        let path = if op.starts_with("images.") {
            "/internal/images/calls"
        } else {
            "/internal/browser/calls"
        };
        let body = json!({"op":op,"session":self.session,"tab":tab,"args":args,"call_id":call_id,"turn_id":self.turn,"schedule_browser":self.schedule_browser});
        let deadline = Instant::now() + Duration::from_secs(31);
        let request = async {
            match self
                .admin
                .request(Method::POST, path, Some(&body), Some(deadline))
                .await
            {
                Ok(response) if response.status().is_success() => response
                    .bytes()
                    .await
                    .ok()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or_else(|| json!({"status":"unknown","reason":"invalid_result"})),
                Ok(response) if response.status().is_server_error() => {
                    json!({"status":"unknown","reason":"browser_result_unknown"})
                }
                Ok(_) => json!({"status":"not_dispatched","reason":"browser_refused"}),
                Err(_) => json!({"status":"unknown","reason":"browser_host_lost"}),
            }
        };
        let mut result = tokio::select! {
            ()=signal.cancelled()=>{
                let body = json!({"op":"tab.cancel","session":self.session,"tab":tab,"args":{"call_id":call_id}});
                let deadline = Instant::now() + Duration::from_secs(2);
                let _ = self.admin.request(Method::POST, "/internal/browser/calls", Some(&body), Some(deadline)).await;
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
