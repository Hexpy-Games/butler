//! A page dialog met by a browser call: an alert is acknowledged; any other needs the owner's approval.
use super::super::GuidedTools;
use super::{
    ApprovedBatch, authority, client, dispatch_effect, encoded, finish_batch, handoff, settle,
};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};
pub(super) async fn finish(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: &Value,
    pending: &Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let tab = &pending["tab"];
    let page = json!({"kind":"web_page_data","dialog":pending["dialog"]});
    if pending["dialog"]["type"] == "alert" {
        let mut result = client
            .call(
                "tab.dialog",
                tab,
                &json!({"dialog":pending["dialog"]["id"],"accept":true}),
                invocation.cancellation,
            )
            .await;
        result["untrusted_content"] = page;
        return finish_batch(args, result);
    }
    if client.approval_handoff {
        let mut value = handoff(args, "dialog_pending");
        value["handoff"]["tab"] = tab.clone();
        value["untrusted_content"] = page;
        return encoded(&value);
    }
    let scope = butler_runtime::browser::site_scope(pending["url"].as_str().unwrap_or(""))
        .unwrap_or_default();
    let input = json!({"tab":tab,"observation":args["observation"],"steps":args["steps"],"dialog":pending["dialog"],"site":scope,"mode":"signed_out","always_confirm":true});
    let approval = match authority::gate(owner, call, occurrence, &input, &scope).await? {
        authority::Gate::Pending(value) => {
            if value["error"] == "authority_request_denied" {
                client
                    .call(
                        "tab.dialog",
                        tab,
                        &json!({"dialog":pending["dialog"]["id"],"accept":false}),
                        invocation.cancellation,
                    )
                    .await;
            }
            return finish_batch(args, value);
        }
        authority::Gate::Allowed(reference, _) => reference,
    };
    let dispatch = json!({"tab":tab,"dialog":pending["dialog"]["id"],"accept":true,"value":pending["dialog"]["defaultPrompt"]});
    let dialog_occurrence = format!(
        "{occurrence}:dialog:{}",
        pending["dialog"]["id"].as_str().unwrap_or("")
    );
    let mut result = dispatch_effect(
        owner,
        invocation,
        &dialog_occurrence,
        client,
        ApprovedBatch {
            args: &dispatch,
            prepared: &Value::Null,
            input,
            scope: &scope,
        },
    )
    .await?;
    settle(
        owner,
        approval,
        result["status"].as_str().unwrap_or("unknown"),
    )
    .await?;
    result["untrusted_content"] = page;
    finish_batch(args, result)
}
