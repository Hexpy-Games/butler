//! Always-confirm dialogs continue the original call without replaying its click.
use super::super::GuidedTools;
use super::{ApprovedBatch, authority, client, dispatch_effect, finish_batch, settle};
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
    if pending["dialog"]["type"] == "alert" {
        let mut result = client
            .call(
                "tab.dialog",
                &args["tab"],
                &json!({"dialog":pending["dialog"]["id"],"accept":true}),
                invocation.cancellation,
            )
            .await;
        result["untrusted_content"] = json!({"kind":"web_page_data","dialog":pending["dialog"]});
        return finish_batch(args, result);
    }
    let scope = butler_runtime::browser::site_scope(pending["url"].as_str().unwrap_or(""))
        .unwrap_or_default();
    let input = json!({"tab":args["tab"],"observation":args["observation"],"steps":args["steps"],"dialog":pending["dialog"],"site":scope,"mode":"signed_out","always_confirm":true});
    let approval = match authority::gate(owner, call, occurrence, &input, &scope).await? {
        authority::Gate::Pending(value) => {
            if value["error"] == "authority_request_denied" {
                client
                    .call(
                        "tab.dialog",
                        &args["tab"],
                        &json!({"dialog":pending["dialog"]["id"],"accept":false}),
                        invocation.cancellation,
                    )
                    .await;
            }
            return finish_batch(args, value);
        }
        authority::Gate::Allowed(reference) => reference,
    };
    let dispatch = json!({"tab":args["tab"],"dialog":pending["dialog"]["id"],"accept":true,"value":pending["dialog"]["defaultPrompt"]});
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
    result["untrusted_content"] = json!({"kind":"web_page_data","dialog":pending["dialog"]});
    finish_batch(args, result)
}
