use serde_json::{Value, json};

use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(ToolName::WebSearch | ToolName::WebRead)
    )
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let mut arguments = Value::Object(call.arguments.clone());
    let live = if call.name == ToolName::WebRead {
        match super::super::browser::live_page(owner, &invocation, &arguments).await {
            Ok(live) => live,
            Err(refused) => return super::encoded(&refused),
        }
    } else {
        None
    };
    if arguments["url"].as_str().is_none()
        && let Some(page) = &live
    {
        arguments["url"] = Value::String(page.final_url.clone());
    }
    let approved = match authorize(owner, call, call_id, &arguments, live.is_some()).await? {
        super::file_observation::Gate::Pending(result) => return super::encoded(&result),
        super::file_observation::Gate::Allowed(reference) => reference,
    };
    let result = fetch(owner, invocation, call, &arguments, live).await;
    settle(owner, approved, &result).await?;
    if call.name == ToolName::WebSearch && result["ok"] == true {
        let mut provenance = owner.web_provenance.lock();
        for item in result["results"].as_array().into_iter().flatten() {
            if provenance.len() >= 512 {
                break;
            }
            if let Some(url) = item["url"].as_str() {
                provenance.insert(url.to_owned());
            }
        }
    }
    if call.name == ToolName::WebRead
        && result["ok"] == true
        && let Some(source) = result["source_url"].as_str()
    {
        super::super::answer_blocks::remember_source(owner, call_id, source).await?;
    }
    super::encoded(&result)
}

/// URLs explicitly supplied by the user are trusted only for this turn.
pub(in crate::host::guided::tools) fn web_provenance(
    message: &str,
) -> std::collections::HashSet<String> {
    message
        .split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '(' | ')'))
        .filter(|part| {
            url::Url::parse(part).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
        })
        .take(512)
        .map(str::to_owned)
        .collect()
}

async fn settle(
    owner: &GuidedTools,
    reference: Option<String>,
    result: &Value,
) -> Result<(), ToolExecutionError> {
    if let Some(request_ref) = reference {
        owner
            .authority
            .record_outcome(butler_turn::btcc::AuthorityOutcomeInput {
                request_ref,
                owner_session_id: owner.binding.owner_session_id.clone(),
                source_work_id: String::new(),
                status: if result["ok"] == true {
                    "applied"
                } else {
                    "failed"
                }
                .into(),
                receipt: None,
            })
            .await
            .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
        *owner.authority_consumed.lock() = true;
    }
    Ok(())
}

async fn fetch(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    arguments: &Value,
    live: Option<butler_runtime::web_access::LivePage>,
) -> Value {
    if call.name == ToolName::WebSearch {
        owner
            .web_session
            .web_search(arguments, invocation.cancellation)
            .await
    } else {
        owner
            .web_session
            .web_read_from(arguments, live, invocation.cancellation)
            .await
    }
    .unwrap_or_else(
        |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
    )
}

async fn authorize(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    arguments: &Value,
    open_tab: bool,
) -> Result<super::file_observation::Gate, ToolExecutionError> {
    let target = arguments[if call.name == ToolName::WebSearch {
        "query"
    } else {
        "url"
    }]
    .as_str()
    .unwrap_or("");
    let carries_data = if call.name == ToolName::WebSearch {
        butler_turn::btcc::web_search_carries_data(target)
    } else {
        // A page already open in a tab is read there; no request leaves.
        butler_turn::btcc::web_read_carries_data(
            target,
            open_tab || owner.web_provenance.lock().contains(target),
        )
    };
    let decision = super::super::access::for_kind(
        owner,
        butler_turn::btcc::CapabilityKind::WebRequest { carries_data },
    );
    if matches!(decision, butler_turn::btcc::AccessDecision::Deny(_)) {
        return Ok(super::file_observation::Gate::Pending(
            json!({"ok":false,"error":{
                "code":"web_request_blocked_after_external_content",
                "message":"This read-only turn read outside content, so it cannot send a request that may carry it.",
                "recoverable":true,
                "next_action":"Continue without this request.",
            }}),
        ));
    }
    if matches!(decision, butler_turn::btcc::AccessDecision::Ask(_))
        || super::super::access::resumes(owner, call_id)
    {
        super::file_observation::gate(owner, call, call_id, arguments).await
    } else {
        Ok(super::file_observation::Gate::Allowed(None))
    }
}
