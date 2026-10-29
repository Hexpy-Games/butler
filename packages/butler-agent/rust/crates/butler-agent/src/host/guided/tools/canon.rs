//! Butler-only tool boundary. Ask is a nonblocking canon draft, never authority wait.
use super::GuidedTools;
use butler_core::{json::JsonDocument, tool_protocol::ToolName};
use butler_turn::btcc::{AccessDecision, CapabilityKind, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let writing = call.name == ToolName::CanonPropose;
    let decision = super::access::for_kind(
        owner,
        if writing {
            CapabilityKind::CanonProposal
        } else {
            CapabilityKind::InternalRead
        },
    );
    if matches!(decision, AccessDecision::Deny(_)) {
        return super::dispatch::encoded(
            &json!({"ok":false,"error":{"code":"read_only","message":"This conversation is read-only, so canon cannot change. Tell the user in one sentence; they can change the permission level."}}),
        );
    }
    let Some(session) = owner.binding.app_session_id.as_deref() else {
        return super::dispatch::encoded(&json!({"ok":false,"error":{"code":"no_app_chat"}}));
    };
    let result = request(
        owner,
        if writing { "propose" } else { "read" },
        json!({"session_id":session,
        "turn_id":owner.binding.turn_id,"call_id":call_id,"arguments":call.arguments,
        "apply":writing && decision==AccessDecision::Allow}),
    )
    .await;
    if writing && result["ok"] == true {
        let entry=(result["state"]=="draft").then(||json!({"ask_id":result["ask_id"],"kind":"canon_proposal",
            "title":call.arguments.get("summary"),"created_at":chrono::Utc::now().to_rfc3339(),"resolved_at":null}));
        owner.binding.open_asks.lock().replace_canon(entry);
    }
    super::dispatch::encoded(&result)
}
pub(super) async fn request(owner: &GuidedTools, action: &str, mut input: Value) -> Value {
    let Some(session) = owner.binding.app_session_id.as_deref() else {
        return json!({"ok":false,"error":{"code":"no_app_chat"}});
    };
    input["session_id"] = json!(session);
    let client = match crate::host::automation::client::ScheduleClient::active(&owner.app_endpoint)
    {
        Ok(client) => client,
        Err(error) => {
            return json!({"ok":false,"error":{"code":error.code(),"message":error.message()}});
        }
    };
    client
        .request(
            reqwest::Method::POST,
            &format!("/sessions/{session}/canon/{action}"),
            Some(input),
        )
        .await
        .unwrap_or_else(
            |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
        )
}
