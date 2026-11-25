mod apply;
mod card;

use super::{GuidedTools, admin_client::AdminClient, dispatch::encoded};
use butler_core::{json::JsonDocument, tool_protocol::ToolName};
use butler_models::models::parse_computer_environment;
use butler_turn::btcc::{
    AccessDecision, AuthorityExecutionInput, BtccError, CapabilityKind, GuidedInvocation,
    ModelRoundToolCall, RequestOutcome, ToolExecutionError, TurnTaint, UserQuestionResponse,
    UserQuestions, question_request_ref,
};
use http::Method;
use serde_json::{Value, json};

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(
            ToolName::ComputerList
                | ToolName::ComputerAdd
                | ToolName::ComputerEdit
                | ToolName::ComputerRemove
        )
    )
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let Some(tool) = ToolName::parse(&call.name) else {
        return encoded(&failure("invalid_arguments", "Unknown computer tool."));
    };
    if owner.unattended() || !owner.authorized(&call.name) {
        return encoded(&failure("disabled_tool", "Tool is disabled."));
    }
    if tool == ToolName::ComputerList {
        if !call.arguments.is_empty() {
            return encoded(&failure(
                "invalid_arguments",
                "Computer listing takes no arguments.",
            ));
        }
        return tokio::select! {
            () = invocation.cancellation.cancelled() => encoded(&json!({"ok":false,"status":"cancelled"})),
            value = list(owner) => encoded(&value.unwrap_or_else(gateway_failure)),
        };
    }
    if owner.taint() == TurnTaint::External {
        return encoded(&failure(
            "external_content_refused",
            "Computer setup is unavailable after reading external content.",
        ));
    }
    if super::access::for_kind(owner, CapabilityKind::ComputerSetup) != AccessDecision::Allow {
        return encoded(&json!({"ok":false,"error":"tool_not_admitted"}));
    }

    write(owner, invocation, call, call_id, tool).await
}

async fn write(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
    tool: ToolName,
) -> Result<JsonDocument, ToolExecutionError> {
    let request_ref = question_request_ref(&owner.binding.turn_id, call_id);
    let execution = owner
        .authority
        .execution(AuthorityExecutionInput {
            owner_session_id: owner.binding.owner_session_id.clone(),
            request_ref: request_ref.clone(),
            source_session_id: Some(owner.binding.source_session_id.clone()),
            client_message_id: None,
            turn_id: owner.binding.turn_id.clone(),
        })
        .await;
    let execution = match execution {
        Ok(execution) => execution,
        Err(error) if error.code() == "authority_request_not_found" => {
            return tokio::select! {
                () = invocation.cancellation.cancelled() => encoded(&json!({"ok":false,"status":"cancelled"})),
                questions = card::build(owner, tool, &call.arguments) => match questions {
                    Ok(questions) => super::question::admit(owner, call_id, questions, true, Some(call.name.clone())).await,
                    Err(error) => encoded(&gateway_failure(error)),
                }
            };
        }
        Err(error) => {
            let error = BtccError::from(error);
            return encoded(&failure(error.code(), error.message()));
        }
    };
    if execution.outcome == RequestOutcome::Applied {
        return encoded(&json!({"ok":false,"error":{"code":"already_applied"}}));
    }
    let UserQuestionResponse::Answered { answers } = execution
        .question_response()
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?
    else {
        return encoded(&json!({"ok":true,"deferred":true,"applied":false}));
    };
    let values = serde_json::from_value::<UserQuestions>(execution.normalized_input)
        .ok()
        .and_then(|questions| card::answers(tool, &questions, &answers));
    let Some((id, values)) = values else {
        return encoded(&failure(
            "card_mismatch",
            "The stored computer card does not match this tool.",
        ));
    };
    if values.is_empty() || (tool == ToolName::ComputerAdd && values.len() != 4) {
        return encoded(&json!({"ok":true,"cancelled":true}));
    }
    apply::claimed(
        owner,
        invocation.cancellation,
        tool,
        request_ref,
        id,
        values,
    )
    .await
}

async fn list(owner: &GuidedTools) -> Result<Value, Value> {
    let client = admin(owner).await?;
    let data = client.data(Method::GET, "/computers", None).await?;
    let credentials = client.data(Method::GET, "/credentials", None).await?;
    let labels: std::collections::HashMap<_, _> = rows(&credentials, "credentials")
        .iter()
        .filter_map(|credential| Some((credential["id"].as_str()?, credential["label"].as_str()?)))
        .collect();
    let computers: Vec<_> = rows(&data, "computers")
        .iter()
        .map(|computer| {
            let source = &computer["model_source"];
            let model = if let Some(id) = source["key"].as_str() {
                let label = labels.get(id).copied().unwrap_or("missing");
                format!("key:{label}")
            } else {
                source.as_str().unwrap_or("none").to_owned()
            };
            let mut view = computer_view(computer);
            view["model"] = json!(model);
            view
        })
        .collect();
    Ok(json!({"ok":true,"computers":computers}))
}

fn computer_view(computer: &Value) -> Value {
    let variables = computer["environment_text"]
        .as_str()
        .and_then(|text| parse_computer_environment(text, &Default::default()).ok())
        .map(|entries| entries.into_keys().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "id":computer["id"], "name":computer["name"], "address":computer["address"],
        "port":computer["port"], "key_file":computer["key_file"], "folder":computer["folder"],
        "ai_connected":computer["ai_connected"], "stops_on_logout":computer["stops_on_logout"],
        "variables":variables, "secrets":rows(computer, "environment"),
    })
}

fn mutation_view(computer: &Value) -> Value {
    let mut view = computer_view(computer);
    for field in ["os", "arch", "glibc", "added_at", "model_source"] {
        view[field] = computer[field].clone();
    }
    view
}

async fn admin(owner: &GuidedTools) -> Result<AdminClient, Value> {
    AdminClient::new(owner)
        .await
        .ok_or_else(|| error("gateway_unavailable", "Could not reach the Butler gateway."))
}

fn rows<'a>(data: &'a Value, field: &str) -> &'a [Value] {
    data[field].as_array().map_or(&[], Vec::as_slice)
}

fn error(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message})
}

fn not_found() -> Value {
    error("computer_not_found", "Computer not found.")
}

fn failure(code: &str, message: &str) -> Value {
    gateway_failure(error(code, message))
}

fn gateway_failure(error: Value) -> Value {
    Value::Object(serde_json::Map::from_iter([
        ("ok".into(), Value::Bool(false)),
        ("error".into(), error),
    ]))
}
