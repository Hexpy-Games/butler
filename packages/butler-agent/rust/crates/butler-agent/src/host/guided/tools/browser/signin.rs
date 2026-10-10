//! `browser_sign_in {tab}`: Butler fills a saved sign-in without the model
//! ever seeing it. Policy `ask` raises one exact card; human steps (MFA,
//! passkey, CAPTCHA, security keypad) hand the tab to the user and the call
//! resumes durably on the hand-back.
use super::super::{GuidedTools, dispatch::encoded};
use super::{authority, client, grant, page_data, settle};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{AccessMode, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode == AccessMode::ReadOnly {
        return encoded(&json!({"status":"not_dispatched","reason":"read_only"}));
    }
    let tab = args["tab"].clone();
    let signal = invocation.cancellation;
    if let Some(input) = authority::bound(owner, call, occurrence).await?
        && input.get("wait").is_some()
    {
        settle(owner, owner.binding.authority_request_ref.clone(), "ok").await?;
        return encoded(&json!({"status":"ready","observe_required":true,
            "note":"The user finished the sign-in step and handed the tab back. Observe before continuing."}));
    }
    let request = ("signin.lookup", &tab, &json!({}));
    let looked = grant::call(owner, call, occurrence, &client, request, signal).await?;
    if looked["status"] != "ok" {
        return encoded(&looked);
    }
    let entry = &looked["entry"];
    let site = looked["site"].as_str().unwrap_or("");
    let mut approval = None;
    if entry["policy"] != "always" {
        let input = json!({"sign_in":{"site":site,"username":entry["username"],"entry":entry["id"]},
            "tab":tab,"mode":"signed_in","always_confirm":true});
        let target = butler_runtime::browser::signed_in_scope(site);
        match authority::gate(owner, call, occurrence, &input, &target).await? {
            authority::Gate::Pending(pending) => return encoded(&pending),
            authority::Gate::Allowed(reference) => approval = reference,
        }
    }
    let result = client
        .call(
            "signin.fill",
            &tab,
            &json!({"entry_id": entry["id"]}),
            signal,
        )
        .await;
    let status = match result["status"].as_str() {
        Some("filled" | "user_required") => "ok",
        Some("unknown") => "unknown",
        _ => "failed",
    };
    settle(owner, approval, status).await?;
    if result["status"] == "user_required" {
        return hand_over(
            owner,
            invocation,
            call,
            occurrence,
            &client,
            &tab,
            (&result, site),
        )
        .await;
    }
    encoded(&page_data(result))
}

/// Main already gave the tab to the user; wait durably for the hand-back.
async fn hand_over(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: &client::Client,
    tab: &Value,
    (result, site): (&Value, &str),
) -> Result<JsonDocument, ToolExecutionError> {
    let reason = result["reason"].as_str().unwrap_or("unknown_form");
    let input = json!({"wait":{"site":site,"reason":reason},"tab":tab,"always_confirm":true});
    let target = tab.as_str().unwrap_or("");
    match authority::gate(owner, call, occurrence, &input, target).await? {
        authority::Gate::Pending(mut pending) => {
            client.waiting(tab, true, invocation.cancellation).await;
            pending["status"] = json!("user_required");
            pending["reason"] = json!(reason);
            pending["recovery"] = json!(
                "The user finishes this step in the tab; Butler resumes when they hand it back."
            );
            encoded(&pending)
        }
        authority::Gate::Allowed(reference) => {
            settle(owner, reference, "ok").await?;
            encoded(&json!({"status":"ready","observe_required":true}))
        }
    }
}
