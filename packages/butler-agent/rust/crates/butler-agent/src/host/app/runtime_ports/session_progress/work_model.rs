use butler_turn::btcc::{BtccError, work_model::*};
use serde_json::{Value, json};

pub(super) async fn view_and_wake(
    service: &WorkModelService,
    subsessions: &butler_turn::btcc::SubsessionService,
    session: String,
    view_name: &str,
    input: Value,
) -> Result<Value, BtccError> {
    let result = view(service, session.clone(), view_name, input).await?;
    if view_name == "instruction" {
        subsessions.wake_instruction(&session, &result).await?;
    }
    if view_name == "outbox" {
        for event in result.as_array().into_iter().flatten() {
            if event["kind"] == "session.control_changed" {
                let target = event["session_id"].as_str().unwrap_or_default();
                if target.starts_with("worker-") || target.starts_with("steward-") {
                    subsessions.wake_session_instructions(target).await?;
                }
            }
            if event["kind"] == "instruction.updated"
                && event["receipt"]["status"] == "pending_safe_point"
            {
                let target = event["session_id"].as_str().unwrap_or_default();
                if target.starts_with("worker-") || target.starts_with("steward-") {
                    subsessions
                        .wake_instruction(target, &event["receipt"])
                        .await?;
                }
            }
        }
    }
    Ok(result)
}

pub(super) async fn view(
    service: &WorkModelService,
    session: String,
    view: &str,
    input: Value,
) -> Result<Value, BtccError> {
    let cursor = input["cursor"].as_str().map(str::to_owned);
    match view {
        "outbox" => {
            service
                .outbox(input["after"].as_u64().unwrap_or_default())
                .await
        }
        "summary" => service.summary(session, cursor).await,
        "graph" => service.graph(session, cursor).await,
        "plan_graph" => service.graph_plan(session, cursor).await,
        "spec" => {
            service
                .read_spec(
                    session,
                    input["node_id"].as_str().unwrap_or_default().into(),
                )
                .await
        }
        "apply" => service.apply(session, decode_request(input)?).await,
        "instruction" | "app_instruction" => admit(service, session, view, input).await,
        "instructions" => {
            service
                .instructions(
                    session,
                    input["after"]
                        .as_str()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or_default(),
                )
                .await
        }
        "interrupted_boundary" => {
            service
                .interrupted_boundary(
                    session,
                    input["turn_id"].as_str().unwrap_or_default().into(),
                )
                .await
        }
        "instruction_dispatch" => {
            service
                .instruction_dispatch(
                    session,
                    input["idempotency_key"].as_str().unwrap_or_default().into(),
                )
                .await
        }
        "instruction_receipt" => {
            service
                .instruction_receipt(
                    session,
                    input["idempotency_key"].as_str().unwrap_or_default().into(),
                )
                .await
        }
        _ => Err(BtccError::relayed(
            "work_model_view_invalid",
            "work_model_view_invalid",
        )),
    }
}

pub(super) fn result(result: Result<Value, BtccError>, revision: Option<u64>) -> Value {
    result
        .and_then(|value| {
            if revision.is_some_and(|r| value["graph_revision"].as_u64() != Some(r)) {
                return Err(BtccError::relayed(
                    "graph_revision_conflict",
                    "graph_revision_conflict",
                ));
            }
            Ok(value)
        })
        .unwrap_or_else(
            |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
        )
}

async fn admit(
    service: &WorkModelService,
    session: String,
    view: &str,
    mut input: Value,
) -> Result<Value, BtccError> {
    let anchor = if view == "app_instruction" {
        input
            .as_object_mut()
            .and_then(|v| v.remove("transport_turn_id"))
            .and_then(|v| v.as_str().map(str::to_owned))
    } else {
        None
    };
    let input: InstructionInput = serde_json::from_value(input).map_err(|e| {
        BtccError::relayed("instruction_invalid", "instruction_invalid").with_source(e)
    })?;
    service
        .instruct_app(
            session,
            InstructionSender::User {
                principal_id: "app-user".into(),
            },
            input,
            anchor,
        )
        .await
}
