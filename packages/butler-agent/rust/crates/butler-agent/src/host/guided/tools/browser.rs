//! Conversation-owned browser tools; web content cannot select authority or owners.
mod authority;
mod client;
mod dialog;
mod effect;
use super::{GuidedTools, dispatch::encoded};
use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AccessMode, AuthorityOutcomeInput, EffectAccess, EffectOutcome, ExecuteEffect,
    GuidedInvocation, ModelRoundToolCall, ToolExecutionError,
};
use serde_json::{Value, json};
use std::sync::Arc;
pub(super) fn supports(name: &str) -> bool {
    matches!(
        name,
        "browser_open"
            | "browser_observe"
            | "browser_act"
            | "browser_tabs"
            | "browser_close"
            | "browser_wait_for_user"
    )
}
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    if std::env::var_os("BUTLER_BROWSER_DISABLED").is_some()
        || owner
            .binding
            .allowed_tools_and_effects
            .as_ref()
            .is_some_and(|names| !names.iter().any(|name| name == &call.name))
    {
        return encoded(&json!({"status":"not_dispatched","reason":"tool_not_admitted"}));
    }
    let Some(client) = client::Client::new(owner).await else {
        return encoded(&json!({"status":"unavailable","reason":"no_browser"}));
    };
    let args = Value::Object(call.arguments.clone());
    if call.name == "browser_act" {
        return act(owner, invocation, call, occurrence, client, args).await;
    }
    if call.name == "browser_wait_for_user" {
        return wait(owner, invocation, call, occurrence, client, args).await;
    }
    let op = match call.name.as_str() {
        "browser_open" => "tab.open",
        "browser_observe" => "tab.observe",
        "browser_close" => "tab.close",
        _ => "tabs.list",
    };
    let mut result = client
        .call(op, &args["tab"], &args, invocation.cancellation)
        .await;
    if call.name == "browser_close" && result["status"] == "dialog_pending" {
        return dialog::finish(owner, invocation, call, occurrence, client, &args, &result).await;
    }
    if call.name == "browser_observe" && result["status"] == "ok" {
        result["schema"] = json!("butler.browser-observation.v1");
        result["untrusted_content"] = json!({"kind":"web_page_data","text":result["text"],"url":result["url"],"frames":result["frames"],"payment":result["payment"],"addons":result["addons"]});
        if let Some(object) = result.as_object_mut() {
            object.remove("text");
            object.remove("nodes");
            object.remove("frames");
            object.remove("payment");
            object.remove("addons");
        }
    }
    encode_page_data(result)
}
async fn act(
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
    let mut prepared = client
        .call("tab.prepare", &args["tab"], &args, invocation.cancellation)
        .await;
    if prepared["status"] == "dialog_pending" {
        return dialog::finish(
            owner, invocation, call, occurrence, client, &args, &prepared,
        )
        .await;
    }
    if prepared["status"] != "ok" {
        return encoded(&prepared);
    }
    let scope = butler_runtime::browser::site_scope(prepared["url"].as_str().unwrap_or(""))
        .unwrap_or_default();
    let input = approval_input(&args, &mut prepared, &scope);
    let approval = match authority::act_gate(owner, call, occurrence, &input, &scope).await? {
        authority::Gate::Pending(value) => {
            client
                .waiting(&args["tab"], true, invocation.cancellation)
                .await;
            return encoded(&value);
        }
        authority::Gate::Allowed(reference) => reference,
    };
    client
        .waiting(&args["tab"], false, invocation.cancellation)
        .await;
    let result = dispatch_effect(
        owner,
        invocation,
        occurrence,
        client.clone(),
        ApprovedBatch {
            args: &args,
            prepared: &prepared,
            input,
            scope: &scope,
        },
    )
    .await?;
    if result["status"] == "dialog_pending" {
        settle(owner, approval, "unknown").await?;
        return dialog::finish(owner, invocation, call, occurrence, client, &args, &result).await;
    }
    settle(
        owner,
        approval,
        result["status"].as_str().unwrap_or("unknown"),
    )
    .await?;
    encode_page_data(result)
}
fn encode_page_data(mut value: Value) -> Result<JsonDocument, ToolExecutionError> {
    if let Some(tabs) = value.get_mut("tabs").and_then(Value::as_array_mut) {
        for tab in tabs {
            delimit_labels(tab);
        }
    }
    delimit_labels(&mut value);
    if let Some(steps) = value.get_mut("steps").and_then(Value::as_array_mut) {
        for step in steps {
            if let Some(hit) = step.get_mut("hit").and_then(Value::as_object_mut) {
                hit.insert("kind".into(), json!("untrusted_web_page_data"));
            }
        }
    }
    encoded(&value)
}
fn delimit_labels(value: &mut Value) {
    let Some(record) = value.as_object_mut() else {
        return;
    };
    let mut data = record
        .remove("untrusted_content")
        .unwrap_or_else(|| json!({"kind":"web_page_data"}));
    for key in ["url", "title"] {
        if let Some(label) = record.remove(key) {
            data[key] = label;
        }
    }
    if data.as_object().is_some_and(|data| data.len() > 1) {
        record.insert("untrusted_content".into(), data);
    }
}
fn approval_input(args: &Value, prepared: &mut Value, scope: &str) -> Value {
    let always = prepared["steps"].as_array().is_some_and(|steps| {
        steps.iter().any(|s| {
            s["payment"] == true && s["submit"] == true
                || s["frame_payment"] == true
                || s["hit"]["frame"]
                    .as_str()
                    .is_some_and(butler_runtime::browser::payment_host)
        })
    });
    if let Some(steps) = prepared["steps"].as_array_mut() {
        for step in steps {
            if let Some(map) = step.as_object_mut() {
                map.remove("x");
                map.remove("y");
            }
        }
    }
    json!({"tab":args["tab"],"observation":args["observation"],"steps":args["steps"],"resolved_steps":prepared["steps"],"site":scope,"mode":"signed_out","always_confirm":always})
}
struct ApprovedBatch<'a> {
    args: &'a Value,
    prepared: &'a Value,
    input: Value,
    scope: &'a str,
}
async fn dispatch_effect(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    occurrence: &str,
    client: client::Client,
    batch: ApprovedBatch<'_>,
) -> Result<Value, ToolExecutionError> {
    let ApprovedBatch {
        args,
        prepared,
        input,
        scope,
    } = batch;
    let work = owner
        .work
        .bound_work()
        .await
        .map_err(ToolExecutionError::Integrity)?
        .unwrap_or_else(|| super::effect::runtime_work::untracked(owner));
    let mut dispatch_args = args.clone();
    dispatch_args["prepared_steps"] = prepared["steps"].clone();
    let outcome = owner
        .effects
        .execute(ExecuteEffect {
            work,
            access: EffectAccess::Full,
            occurrence_id: Some(occurrence.into()),
            signal: invocation.cancellation.clone(),
            target: scope.to_owned(),
            input,
            adapter: Arc::new(effect::BrowserEffectAdapter {
                client,
                tab: args["tab"].clone(),
                args: dispatch_args,
            }),
        })
        .await
        .map_err(|e| ToolExecutionError::Integrity(e.into()))?;
    Ok(match outcome {
        EffectOutcome::Applied { result, .. } => {
            serde_json::from_str(result.as_str()).unwrap_or_else(|_| json!({"status":"unknown"}))
        }
        EffectOutcome::Uncertain { .. } => {
            json!({"status":"unknown","reason":"browser_result_unknown"})
        }
        _ => json!({"status":"not_dispatched","reason":"effect_refused"}),
    })
}
async fn wait(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let status = client
        .call("tab.wait", &args["tab"], &args, invocation.cancellation)
        .await;
    if status["status"] != "user_control" && owner.binding.authority_request_ref.is_none() {
        return encoded(&status);
    }
    match authority::gate(
        owner,
        call,
        occurrence,
        &args,
        args["tab"].as_str().unwrap_or(""),
    )
    .await?
    {
        authority::Gate::Pending(value) => {
            // Reconcile a hand-back that raced admission with one change event.
            client
                .waiting(&args["tab"], true, invocation.cancellation)
                .await;
            encoded(&value)
        }
        authority::Gate::Allowed(reference) => {
            settle(owner, reference, "ok").await?;
            encoded(&json!({"status":"ready","observe_required":true}))
        }
    }
}
async fn settle(
    owner: &GuidedTools,
    reference: Option<String>,
    status: &str,
) -> Result<(), ToolExecutionError> {
    if let Some(request_ref) = reference {
        owner
            .authority
            .record_outcome(AuthorityOutcomeInput {
                request_ref,
                owner_session_id: owner.binding.owner_session_id.clone(),
                source_work_id: String::new(),
                status: match status {
                    "ok" => "applied",
                    "unknown" => "uncertain",
                    _ => "failed",
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
