//! `observe: true` folds the follow-up observation into the act result: one model
//! round per batch instead of act + observe. The observation is the newest cycle.
use super::super::GuidedTools;
use super::{batch_value, client::Client, images, page_data, project_observation};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{GuidedInvocation, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn finish(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    client: &Client,
    args: &Value,
    result: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let dispatched = matches!(
        result["status"].as_str(),
        Some("ok" | "interrupted" | "unknown")
    );
    let mut action = batch_value(args, result);
    if args["observe"] != true || !dispatched {
        return super::encoded(&action);
    }
    if !client
        .vision(&invocation.model_execution.active_model_ref())
        .await
    {
        action["observation"] = json!({"status":"unavailable","reason":"vision_required"});
        return super::encoded(&action);
    }
    let mut observation = client
        .call(
            "tab.observe",
            &args["tab"],
            &json!({"tab":args["tab"],"include_image":true,"settle":true}),
            invocation.cancellation,
        )
        .await;
    images::finish(owner, "browser_observe", &mut observation).await?;
    if observation["status"] != "ok" {
        action["observation"] = json!({"status":observation["status"],"reason":observation["reason"],
            "recovery":"The batch result above is authoritative. Call browser_observe before the next action."});
        return super::encoded(&action);
    }
    project_observation(&mut observation);
    super::encoded(&combine(observation, action))
}

/// The observation keeps its schema so pixels, supersession and replay treat it
/// as the newest cycle; the batch receipts ride along under `action`.
pub(super) fn combine(observation: Value, mut action: Value) -> Value {
    let mut combined = page_data(observation);
    if let Some(still) = action.as_object_mut().and_then(|a| a.remove("still_file")) {
        combined["still_file"] = still;
    }
    combined["action"] = action;
    combined
}
