//! Session-bound publication and bounded App self-check.
use super::GuidedTools;
use butler_runtime::outputs::{OutputStore, PublishRequest};
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};

pub(super) async fn publish(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<butler_core::json::JsonDocument, ToolExecutionError> {
    if matches!(
        super::access::for_kind(owner, butler_turn::btcc::CapabilityKind::ButlerOutput),
        butler_turn::btcc::AccessDecision::Deny(_)
    ) {
        return super::dispatch::encoded(&json!({"ok":false,"error":"tool_not_admitted"}));
    }
    let args = &call.arguments;
    let request = PublishRequest {
        workspace: owner.binding.workspace_path.clone(),
        path: args
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        entry: args.get("entry").and_then(Value::as_str).map(str::to_owned),
        title: args
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        session_id: owner
            .binding
            .app_session_id
            .clone()
            .unwrap_or_else(|| owner.binding.source_session_id.clone()),
        message_id: invocation.turn.original_message_id.clone(),
        turn_id: owner.binding.turn_id.clone(),
    };
    if owner
        .binding
        .allowed_tools_and_effects
        .as_ref()
        .is_some_and(|names| {
            !names.iter().any(|n| {
                n == "output_publish"
                    || n == "output_publish:workspace"
                    || n == "write_file:workspace"
            })
        })
    {
        return super::dispatch::encoded(&json!({"ok":false,"error":"tool_not_admitted"}));
    }
    let store = OutputStore::new(&owner.binding.butler_data);
    let result = tokio::task::spawn_blocking(move || store.publish(request)).await;
    let value = match result {
        Ok(Ok((output, new_blobs))) => {
            let revision = output.revisions.last().map_or(0, |r| r.revision);
            let check = check(owner, invocation, &json!({"output_id":output.output_id})).await;
            json!({"output_id":output.output_id,"revision":revision,"view":format!("/outputs/{}/view",output.output_id),"new_blobs":new_blobs,"check":check})
        }
        Ok(Err(error)) => json!({"ok":false,"error":error.to_string()}),
        Err(_) => json!({"ok":false,"error":"output_publish_failed"}),
    };
    super::dispatch::encoded(&value)
}

pub(super) async fn inspect(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<butler_core::json::JsonDocument, ToolExecutionError> {
    let mut result = check(owner, invocation, &Value::Object(call.arguments.clone())).await;
    if result.get("image").is_some() {
        result["schema"] = json!("butler.output-check.v1");
    }
    super::dispatch::encoded(&result)
}
async fn check(owner: &GuidedTools, invocation: &GuidedInvocation<'_>, args: &Value) -> Value {
    let image = args["include_image"].as_bool().unwrap_or(false);
    {
        let mut state = owner.state.lock();
        if state.output_checks >= 6 || (image && state.output_images >= 3) {
            return json!({"status":"budget_exhausted"});
        }
        state.output_checks += 1;
        if image {
            state.output_images += 1;
        }
    }
    let Some(endpoint) = owner.app_endpoint.snapshot() else {
        return json!({"status":"unavailable","reason":"no_browser"});
    };
    let data = owner.binding.butler_data.clone();
    let admin = tokio::task::spawn_blocking(move || {
        let file = butler_platform::secure_fs::open_read_no_follow(
            &data.join("app/runtime/auth/local-admin.json"),
        )?;
        serde_json::from_reader::<_, Value>(file).map_err(std::io::Error::other)
    })
    .await;
    let Ok(Ok(admin)) = admin else {
        return json!({"status":"unavailable","reason":"no_browser"});
    };
    let client = reqwest::Client::new();
    let bearer = endpoint.local_auth.token().unwrap_or_default();
    if image
        && !vision(
            &client,
            &endpoint.base_url,
            &bearer,
            &invocation.model_execution.active_model_ref(),
        )
        .await
    {
        return json!({"status":"unavailable","reason":"vision_required"});
    }
    let mut args = args.clone();
    args["session_id"] = json!(
        owner
            .binding
            .app_session_id
            .as_ref()
            .unwrap_or(&owner.binding.source_session_id)
    );
    let request = client
        .post(format!("{}/internal/browser/calls", endpoint.base_url))
        .bearer_auth(bearer)
        .header("x-butler-admin", admin["secret"].as_str().unwrap_or(""))
        .json(&args)
        .timeout(std::time::Duration::from_secs(9))
        .send();
    let mut result = tokio::select! {
        () = invocation.cancellation.cancelled() => json!({"status":"unknown","reason":"cancelled"}),
        result = request => match result {
            Ok(response) if response.status().is_success() => response.json::<Value>().await.unwrap_or_else(|_| json!({"status":"unknown","reason":"invalid_result"})),
            _ => json!({"status":"unknown","reason":"browser_host_lost"}),
        }
    };
    // Output checks share the bounded retained browser context budget.
    let _ = super::browser::images::finish(owner, "output_check", &mut result).await;
    result
}
pub(super) async fn vision(
    client: &reqwest::Client,
    base: &str,
    bearer: &str,
    model: &str,
) -> bool {
    let Ok(response) = client
        .get(format!("{base}/model-catalog"))
        .bearer_auth(bearer)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
    else {
        return false;
    };
    let Ok(value) = response.json::<Value>().await else {
        return false;
    };
    value["data"]["models"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|m| {
            m["model_ref"] == model
                && m["image_input_support"] == "supported"
                && matches!(
                    m["image_carrier_protocol"].as_str(),
                    Some(
                        "openai_responses"
                            | "openai_chat_completions"
                            | "anthropic_messages"
                            | "gemini_generate_content"
                    )
                )
        })
}

pub(super) async fn restore_budget(
    owner: &GuidedTools,
    records: &[butler_turn::btcc::ToolJournalSignature],
) -> Result<(), butler_turn::btcc::BtccError> {
    let mut bytes = 0;
    let mut browser_bytes = std::collections::HashMap::new();
    for record in records {
        let name = if record.tool_name == "tool_call" {
            record.arguments["id"]
                .as_str()
                .unwrap_or("")
                .strip_prefix("native:")
                .unwrap_or("")
        } else {
            &record.tool_name
        };
        if matches!(
            name,
            "browser_observe" | "browser_screenshot" | "output_check" | "output_publish"
        ) && let Some(saved) = owner
            .journal
            .find_for_turn(owner.binding.turn_id.clone(), record.call_id.clone())
            .await?
            && let Some(result) = saved.result
        {
            let value: Value = serde_json::from_str(result.as_str()).unwrap_or(Value::Null);
            for data in [
                value.pointer("/image/data"),
                value.pointer("/check/image/data"),
            ]
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            {
                let size = (data.len() / 4 * 3)
                    .saturating_sub(data.bytes().rev().take_while(|b| *b == b'=').count());
                if name == "browser_observe" {
                    if let Some(tab) = value["tab"].as_str() {
                        browser_bytes.insert(tab.to_owned(), size);
                    }
                } else {
                    bytes += size;
                }
            }
        }
        if name == "output_check" || name == "output_publish" {
            let mut state = owner.state.lock();
            state.output_checks = state.output_checks.saturating_add(1);
            if record.arguments["include_image"] == true
                || record.arguments["arguments"]["include_image"] == true
            {
                state.output_images = state.output_images.saturating_add(1);
            }
        }
    }
    let mut state = owner.state.lock();
    state.visual_image_bytes = bytes;
    state.browser_image_bytes = browser_bytes;
    Ok(())
}
