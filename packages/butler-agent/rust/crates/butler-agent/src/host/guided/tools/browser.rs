//! Conversation-owned browser tools; web content cannot select authority or owners.
mod authority;
mod client;
mod dialog;
mod effect;
mod grant;
pub(super) mod images;
mod observe_after;
mod preview;
mod signin;
mod upload;
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
        "preview_start"
            | "preview_stop"
            | "browser_open"
            | "browser_observe"
            | "browser_act"
            | "browser_tabs"
            | "browser_selection"
            | "browser_screenshot"
            | "browser_close"
            | "browser_wait_for_user"
            | "browser_sign_in"
    )
}
pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let mut args = Value::Object(call.arguments.clone());
    if owner
        .binding
        .allowed_tools_and_effects
        .as_ref()
        .is_some_and(|names| !names.iter().any(|name| name == &call.name))
    {
        return finish_batch(
            &args,
            json!({"status":"not_dispatched","reason":"tool_not_admitted"}),
        );
    }
    let Some(client) = client::Client::new(owner).await else {
        return finish_batch(&args, json!({"status":"unavailable","reason":"no_browser"}));
    };
    if matches!(call.name.as_str(), "preview_start" | "preview_stop") {
        return preview::execute(owner, invocation, call, occurrence, client).await;
    }
    if call.name == "browser_close" && owner.binding.access_mode == AccessMode::ReadOnly {
        return encoded(&json!({"status":"not_dispatched","reason":"read_only"}));
    }
    if call.name == "browser_act" {
        return act(owner, invocation, call, occurrence, client, args).await;
    }
    if call.name == "browser_wait_for_user" {
        return wait(owner, invocation, call, occurrence, client, args).await;
    }
    if call.name == "browser_sign_in" {
        return signin::execute(owner, invocation, call, occurrence, client, args).await;
    }
    // look "never" asks for a text-only observation: no screenshot, no vision.
    let text_only =
        call.name == "browser_observe" && args["look"] == "never" && args.get("region").is_none();
    if matches!(call.name.as_str(), "browser_observe" | "browser_screenshot") {
        if !text_only
            && !client
                .vision(&invocation.model_execution.active_model_ref())
                .await
        {
            return encoded(&json!({"status":"unavailable","reason":"vision_required"}));
        }
        if call.name == "browser_observe" {
            args["include_image"] = json!(!text_only);
        }
    }
    // A region makes the observation a close-up of the newest observation.
    let zoom = call.name == "browser_observe" && args.get("region").is_some();
    let request = (host_op(&call.name, zoom), &args["tab"], &args);
    let mut result = grant::call(
        owner,
        call,
        occurrence,
        &client,
        request,
        invocation.cancellation,
    )
    .await?;
    let image_class = if zoom { "browser_zoom" } else { &call.name };
    if !text_only {
        images::finish(owner, image_class, &mut result).await?;
    }
    if result["status"] == "dialog_pending" {
        return dialog::finish(owner, invocation, call, occurrence, client, &args, &result).await;
    }
    if zoom && result["status"] == "ok" {
        result["schema"] = json!("butler.browser-zoom.v1");
    } else if call.name == "browser_observe" && result["status"] == "ok" {
        project_observation(&mut result);
    }
    encode_page_data(result)
}
fn host_op(name: &str, zoom: bool) -> &'static str {
    match name {
        "browser_open" => "tab.open",
        "browser_observe" if zoom => "tab.zoom",
        "browser_observe" => "tab.observe",
        "browser_selection" => "tab.selection",
        "browser_screenshot" => "tab.screenshot",
        "browser_close" => "tab.close",
        _ => "tabs.list",
    }
}
fn project_observation(result: &mut Value) {
    result["schema"] = json!("butler.browser-observation.v1");
    result["untrusted_content"] = json!({"kind":"web_page_data","fields":result["fields"],"layout_regions":result["layout_regions"],"capture_regions":result["capture_regions"],"text":result["text"],"url":result["url"],"frames":result["frames"],"payment":result["payment"],"addons":result["addons"]});
    if let Some(object) = result.as_object_mut() {
        object.remove("text");
        object.remove("nodes");
        object.remove("frames");
        object.remove("fields");
        object.remove("layout_regions");
        object.remove("capture_regions");
        object.remove("payment");
        object.remove("addons");
        for field in [
            "scriptMs",
            "gridSampleMs",
            "walkerMs",
            "proseMs",
            "collectMs",
            "emitMs",
            "cursor",
            "epoch",
        ] {
            object.remove(field);
        }
    }
}

fn has_point_steps(args: &Value) -> bool {
    args["steps"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|step| step.get("point").is_some() || step.get("target_point").is_some())
}
async fn act_refusal(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    client: &client::Client,
    args: &mut Value,
) -> Option<Value> {
    if owner.binding.access_mode == AccessMode::ReadOnly {
        return Some(json!({"status":"not_dispatched","reason":"read_only"}));
    }
    if has_point_steps(args)
        && !client
            .vision(&invocation.model_execution.active_model_ref())
            .await
    {
        return Some(json!({"status":"not_dispatched","reason":"vision_required"}));
    }
    upload::resolve(owner, args).await.err()
}
async fn act(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    occurrence: &str,
    client: client::Client,
    mut args: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    if let Some(refused) = act_refusal(owner, invocation, &client, &mut args).await {
        return finish_batch(&args, refused);
    }
    let request = ("tab.prepare", &args["tab"], &args);
    let mut prepared = grant::call(
        owner,
        call,
        occurrence,
        &client,
        request,
        invocation.cancellation,
    )
    .await?;
    if prepared["authority_pending"] == true {
        return finish_batch(&args, prepared);
    }
    if prepared["status"] == "dialog_pending" {
        return dialog::finish(
            owner, invocation, call, occurrence, client, &args, &prepared,
        )
        .await;
    }
    if prepared["status"] != "ok" {
        authority::refuse_resume(owner, call, occurrence).await?;
        client
            .waiting(&args["tab"], false, invocation.cancellation)
            .await;
        return finish_batch(&args, prepared);
    }
    let scope = act_scope(&prepared);
    let input = approval_input(&args, &mut prepared, &scope);
    let approval = match authority::act_gate(owner, call, occurrence, &input, &scope).await? {
        authority::Gate::Pending(value) => {
            client
                .waiting(
                    &args["tab"],
                    value["authority_pending"] == true,
                    invocation.cancellation,
                )
                .await;
            return finish_batch(&args, value);
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
    observe_after::finish(owner, invocation, &client, &args, result).await
}
pub(super) fn finish_batch(args: &Value, value: Value) -> Result<JsonDocument, ToolExecutionError> {
    encoded(&batch_value(args, value))
}
/// Per-step receipts with delimited page labels, as the model sees a batch.
fn batch_value(args: &Value, mut value: Value) -> Value {
    let count = args["steps"].as_array().map_or(0, Vec::len);
    if count > 0 {
        value["schema"] = json!("butler.browser-action.v1");
    }
    page_data(butler_runtime::browser::batch_receipts(count, value))
}
fn encode_page_data(value: Value) -> Result<JsonDocument, ToolExecutionError> {
    encoded(&page_data(value))
}
fn page_data(mut value: Value) -> Value {
    if let Some(tabs) = value.get_mut("tabs").and_then(Value::as_array_mut) {
        for tab in tabs {
            delimit_labels(tab);
        }
    }
    delimit_labels(&mut value);
    if let Some(events) = value.get_mut("events").and_then(Value::as_array_mut) {
        for event in events {
            delimit_labels(event);
        }
    }
    if let Some(steps) = value.get_mut("steps").and_then(Value::as_array_mut) {
        for step in steps {
            if let Some(hit) = step.get_mut("hit").and_then(Value::as_object_mut) {
                hit.insert("kind".into(), json!("untrusted_web_page_data"));
            }
        }
    }
    value
}
fn delimit_labels(value: &mut Value) {
    let Some(record) = value.as_object_mut() else {
        return;
    };
    let mut data = record
        .remove("untrusted_content")
        .unwrap_or_else(|| json!({"kind":"web_page_data"}));
    for key in ["url", "title", "dialog", "blockedPopup"] {
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
                || s["upload"] == true
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
    let mode = if prepared["profile"] == "signed_in" {
        "signed_in"
    } else {
        "signed_out"
    };
    json!({"tab":args["tab"],"observation":args["observation"],"steps":args["steps"],"resolved_steps":prepared["steps"],"site":scope,"mode":mode,"always_confirm":always})
}
/// The act's authority target: the page's site under its tab profile.
fn act_scope(prepared: &Value) -> String {
    let url = prepared["url"].as_str().unwrap_or("");
    if prepared["profile"] == "signed_in" {
        return butler_runtime::browser::site_of(url)
            .map(|site| butler_runtime::browser::signed_in_scope(&site))
            .unwrap_or_default();
    }
    butler_runtime::browser::site_scope(url).unwrap_or_default()
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
    // Resumed by the hand-back: the stored wait is the decision; the user
    // may have navigated meanwhile, so the page is not re-read for it.
    if authority::bound(owner, call, occurrence).await?.is_some() {
        settle(owner, owner.binding.authority_request_ref.clone(), "ok").await?;
        return encoded(&json!({"status":"ready","observe_required":true}));
    }
    let status = client
        .call("tab.wait", &args["tab"], &args, invocation.cancellation)
        .await;
    if status["status"] != "user_control" && owner.binding.authority_request_ref.is_none() {
        return encoded(&status);
    }
    // The card names the site and why; the tab id stays the request target.
    let reason = args["reason"].as_str().filter(|r| WAIT_REASONS.contains(r));
    let input = json!({"tab":args["tab"],"wait":{"site":status["site"],"reason":reason.unwrap_or("other")}});
    match authority::gate(
        owner,
        call,
        occurrence,
        &input,
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
const WAIT_REASONS: &[&str] = &[
    "sign_in",
    "secure_field",
    "secure_keypad",
    "captcha",
    "other",
];
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
