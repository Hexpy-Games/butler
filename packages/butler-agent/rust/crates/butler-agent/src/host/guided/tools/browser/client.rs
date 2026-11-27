//! Main-only authenticated transport, with credentials never in result JSON.
use super::super::{GuidedTools, admin_client::AdminClient};
use http::Method;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// Why a non-public address does not open in a tab, and where such pages go.
const NON_PUBLIC: &str = "Browser tabs open only public web addresses. Open a local server with preview_start, and hand a local file to the user with deliver_files (a page or site with output_publish). Never open either with run_command.";

/// A direction to work parked on a browser hand-off hands that tab back, as the
/// card's Done does, so the work reads the direction at its next round.
pub(in crate::host::guided::tools) async fn hand_back_directed(
    owner: &GuidedTools,
    relation_id: &str,
) {
    let Some(client) = Client::new(owner).await else {
        return;
    };
    let encode = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let session = encode(&client.session);
    let Ok(page) = client
        .admin
        .data(
            Method::GET,
            &format!("/authority-requests?session_id={session}"),
            None,
        )
        .await
    else {
        return;
    };
    for request in page["requests"].as_array().map_or(&[][..], Vec::as_slice) {
        let (Some(reference), Some(source)) = (
            request["request_ref"].as_str(),
            request["source_session_id"].as_str(),
        ) else {
            continue;
        };
        if owner
            .subsessions
            .direction_waits_on(relation_id, source)
            .await
            .unwrap_or(false)
        {
            let path = format!(
                "/authority-requests/{}/hand-back?session_id={session}",
                encode(reference)
            );
            let _ = client
                .admin
                .data(Method::POST, &path, Some(&json!({})))
                .await;
        }
    }
}

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
                Ok(response) => {
                    let body: Value = response
                        .bytes()
                        .await
                        .ok()
                        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                        .unwrap_or(Value::Null);
                    if body["error"]["code"] == "navigation_denied" {
                        json!({"status":"not_dispatched","reason":"navigation_denied","recovery":NON_PUBLIC})
                    } else {
                        json!({"status":"not_dispatched","reason":"browser_refused"})
                    }
                }
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
