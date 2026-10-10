//! Signed-in site and frame grants: Rust refuses an ungranted call, the user
//! answers one exact card, and the grant then holds for this conversation.
use super::super::GuidedTools;
use super::{authority, client, settle};
use butler_turn::btcc::{ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

/// The grant a refusal asks for, if any.
fn needed(result: &Value) -> Option<Value> {
    let frame = match result["reason"].as_str() {
        Some("signed_in_grant_required") => "",
        Some("frame_grant_required") => result["frame_site"].as_str().unwrap_or(""),
        _ => return None,
    };
    let site = result["site"].as_str().filter(|site| !site.is_empty())?;
    Some(json!({"site": site, "frame_site": frame}))
}

/// Calls `op`; an ungranted site raises the grant card, and an allowed grant
/// is recorded before the call runs once more.
pub(super) async fn call(
    owner: &GuidedTools,
    tool: &ModelRoundToolCall,
    occurrence: &str,
    client: &client::Client,
    request: (&str, &Value, &Value),
    signal: &CancellationToken,
) -> Result<Value, ToolExecutionError> {
    let (op, tab, args) = request;
    let result = client.call(op, tab, args, signal).await;
    let Some(grant) = needed(&result) else {
        return Ok(result);
    };
    let site = grant["site"].as_str().unwrap_or("").to_owned();
    let frame = grant["frame_site"].as_str().unwrap_or("").to_owned();
    let target = if frame.is_empty() {
        butler_runtime::browser::signed_in_scope(&site)
    } else {
        format!("browser:frame:{site}:{frame}")
    };
    let input = json!({"grant": grant, "tab": tab, "mode": "signed_in", "always_confirm": true});
    match authority::gate(owner, tool, occurrence, &input, &target).await? {
        authority::Gate::Pending(mut pending) => {
            pending["site"] = json!(site);
            Ok(pending)
        }
        authority::Gate::Allowed(reference) => {
            let recorded = client.call("signin.grant", tab, &grant, signal).await;
            let status = if recorded["status"] == "ok" {
                "ok"
            } else {
                "failed"
            };
            settle(owner, reference, status).await?;
            Ok(client.call(op, tab, args, signal).await)
        }
    }
}
