//! Native Work tools. Storage owns transactions, snapshots and replay receipts.
use super::GuidedTools;
use butler_core::{json::JsonDocument, tool_protocol::ToolName};
use butler_turn::btcc::{
    BtccError, CutoverAdmission, GuidedInvocation, ModelRoundToolCall, ToolExecutionError,
};
use butler_work::{cutover::ManagedAdmission, store};
use serde_json::{Value, json};

pub(super) fn supports(name: &str) -> bool {
    matches!(
        ToolName::parse(name),
        Some(ToolName::WorkRead | ToolName::WorkApply | ToolName::SessionControl)
    )
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    let storage = owner.journal.work_model_storage();
    let session = owner.binding.source_session_id.clone();
    let raw = Value::Object(call.arguments.clone());
    let value = if call.name == ToolName::WorkRead {
        let input = match serde_json::from_value::<store::tool_read::Read>(raw) {
            Ok(input) => input,
            Err(error) => {
                return encoded(
                    &json!({"ok":false,"error":{"code":"invalid_work_read","message":error.to_string()}}),
                );
            }
        };
        storage.work_model_read(move |db| {
            match store::tool_read::read(db, &session, &input, 1, false) {
                Ok(value) => Ok(value),
                Err(store::Error::Invalid(message)) => Ok(json!({"ok":false,"error":{"code":"invalid_work_read","message":message}})),
                Err(store::Error::NotFound) => Ok(json!({"ok":false,"error":{"code":"work_model_not_found","message":"Use an id from work_read view=tasks."}})),
                Err(error) => Err(error),
            }
        }).await
    } else if call.name == ToolName::WorkApply {
        return apply(owner, invocation, call_id, raw).await;
    } else {
        return encoded(
            &json!({"ok":false,"error":{"code":"session_control_unavailable",
            "message":"session_control is not available yet in this phase."}}),
        );
    };
    match value {
        Ok(value) => encoded(&value),
        Err(error) => Err(ToolExecutionError::Integrity(error.into())),
    }
}

async fn apply(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call_id: &str,
    raw: Value,
) -> Result<JsonDocument, ToolExecutionError> {
    let storage = owner.journal.work_model_storage();
    let receipt = storage
        .admit_work_model(
            ManagedAdmission {
                message_id: invocation.turn.original_message_id.clone(),
                session_id: owner.binding.source_session_id.clone(),
                turn_id: owner.binding.turn_id.clone(),
                body: invocation.turn.original_message.clone(),
                received_seq: 0,
                sender: json!({"user":{"principal_id":"app-user"}}),
            },
            invocation.cancellation,
        )
        .await
        .map_err(integrity)?;
    let CutoverAdmission::Ready(instruction_id) = receipt else {
        return encoded(
            &json!({"ok":false,"pending":true,"error":{"code":"work_cutover_pending",
            "message":"The request is kept pending until the Work model switch completes."}}),
        );
    };
    let session = owner.binding.source_session_id.clone();
    let work = storage
        .work_model_read(move |db| store::bound_work(db, &session, None))
        .await
        .map_err(integrity)?;
    let scope = store::apply::ApplyScope {
        session_id: owner.binding.source_session_id.clone(),
        turn_id: owner.binding.turn_id.clone(),
        instruction_id,
        work_id: work
            .as_ref()
            .and_then(|w| w["id"].as_str())
            .map(str::to_owned),
        tier: 1,
        planning: false,
        floors: store::tiers::Floors::default(),
        child_session: owner.binding.owner_session_id != owner.binding.source_session_id,
    };
    let ctx = store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: json!({"session_id":scope.session_id,"turn_id":scope.turn_id,"origin":"chat"}),
    };
    let call_id = call_id.to_owned();
    let value = storage
        .work_model_write(move |tx| {
            let response = store::apply::apply_tool(tx, &ctx, &scope, &call_id, &raw)?;
            if response["ok"] == true {
                butler_work::cutover::applied(tx, &scope.instruction_id, &scope.session_id)?;
            }
            Ok(response)
        })
        .await
        .map_err(integrity)?;
    encoded(&value)
}

pub(super) async fn effects_allowed(owner: &GuidedTools) -> Result<bool, ToolExecutionError> {
    let session = owner.binding.source_session_id.clone();
    owner
        .journal
        .work_model_storage()
        .work_model_read(move |db| store::tiers::effects_allowed(db, &session))
        .await
        .map_err(integrity)
}
fn integrity(error: butler_turn::btcc::StorageError) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::from(error))
}
fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(super::effect::wire_error)
}
