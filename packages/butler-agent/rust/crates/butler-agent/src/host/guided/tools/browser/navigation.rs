//! Review the complete set of destination URLs before opening any tab.
use super::*;
use butler_turn::btcc::{AccessDecision, CapabilityKind, TurnTaint};

/// Opening pages sends requests as web_read does, so it takes web_read's
/// decision for each destination; a connector event's turn reviews every open.
pub(super) fn reviewed(owner: &GuidedTools, args: &Value) -> bool {
    !matches!(decision(owner, args), AccessDecision::Allow)
}

fn decision(owner: &GuidedTools, args: &Value) -> AccessDecision {
    if owner.taint() == TurnTaint::ConnectorEvent {
        return super::super::access::for_kind(
            owner,
            CapabilityKind::WebRequest { carries_data: true },
        );
    }
    let mut decision = AccessDecision::Allow;
    for url in destinations(owner, args) {
        let next = super::super::access::for_kind(
            owner,
            CapabilityKind::WebRequest {
                carries_data: butler_turn::btcc::web_read_carries_data(
                    &url,
                    owner.web_session.discovered(&url),
                ),
            },
        );
        match next {
            AccessDecision::Deny(_) => return next,
            AccessDecision::Ask(_) => decision = next,
            AccessDecision::Allow => {}
        }
    }
    decision
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if matches!(decision(owner, &args), AccessDecision::Deny(_)) {
        return encoded(&json!({"status":"not_dispatched","reason":"read_only"}));
    }
    let urls = destinations(owner, &args);
    let target = urls.join("\n");
    let steps: Vec<_> = urls
        .iter()
        .map(|url| json!({"action":"navigate","value_preview":url}))
        .collect();
    let input = json!({"navigation":true,"urls":urls,"arguments":args,"resolved_steps":steps});
    if client.approval_handoff {
        return encoded(&handoff(&args, "approval_required"));
    }
    let reference = match authority::gate(owner, call, occurrence, &input, &target).await? {
        authority::Gate::Pending(value) => return encoded(&value),
        authority::Gate::Allowed(reference, _) => reference,
    };
    let result = if args.get("results").is_some() {
        open::execute(owner, invocation, call, occurrence, client).await
    } else {
        let request = ("tab.open", &Value::Null, &args);
        let result = grant::call(
            owner,
            call,
            occurrence,
            &client,
            request,
            invocation.cancellation,
        )
        .await?;
        open::remember(owner, &args, &result);
        if result["status"] == "dialog_pending" {
            dialog::finish(owner, invocation, call, occurrence, client, &args, &result).await
        } else {
            encode_page_data(result)
        }
    };
    let status = match &result {
        Ok(value) if value.field("status").ok().flatten() == Some("ok") => "ok",
        Ok(_) => "failed",
        Err(_) => "unknown",
    };
    settle(owner, reference, status).await?;
    result
}

fn destinations(owner: &GuidedTools, args: &Value) -> Vec<String> {
    if let Some(url) = args["url"].as_str() {
        return vec![url.into()];
    }
    args["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|id| owner.web_session.search_result(id))
        .map(|found| found.url)
        .collect()
}
