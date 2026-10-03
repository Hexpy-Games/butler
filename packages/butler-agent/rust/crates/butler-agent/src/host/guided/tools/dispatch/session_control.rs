use super::*;
use butler_turn::btcc::work_model::InstructionInput;

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    if owner.binding.access_mode == butler_turn::btcc::AccessMode::ReadOnly {
        return encoded(
            &json!({"ok":false,"error":{"code":"parent_instruction_authority_invalid"}}),
        );
    }
    let mut args = call.arguments.clone();
    let target = args
        .remove("target_session_id")
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let result = match serde_json::from_value::<InstructionInput>(Value::Object(args)) {
        Ok(input) => {
            owner
                .subsessions
                .session_control(
                    owner.binding.source_session_id.clone(),
                    owner.binding.turn_id.clone(),
                    target,
                    input,
                )
                .await
        }
        Err(error) => {
            Err(BtccError::relayed("instruction_invalid", "instruction_invalid").with_source(error))
        }
    };
    encoded(&result.unwrap_or_else(
        |error| json!({"ok":false,"error":{"code":error.code(),"message":error.message()}}),
    ))
}

pub(super) async fn legacy_direction(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let instruction = call
        .arguments
        .get("instruction")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolExecutionError::Integrity(BtccError::relayed(
                "steward_direction_instruction_required",
                "instruction is required",
            ))
        })?;
    let result = owner
        .subsessions
        .steer(butler_turn::btcc::SubsessionDirectionRequest {
            parent_session_id: owner.binding.source_session_id.clone(),
            parent_turn_id: owner.binding.turn_id.clone(),
            source_message_id: invocation.turn.original_message_id.clone(),
            relation_id: call
                .arguments
                .get("relation_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            work_id: call
                .arguments
                .get("work_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            safe_title: call
                .arguments
                .get("safe_title")
                .and_then(Value::as_str)
                .map(str::to_owned),
            instruction: instruction.into(),
            child_role: if call.name == ToolName::SteerWorker {
                butler_turn::workspace::SessionRole::Worker
            } else {
                butler_turn::workspace::SessionRole::Steward
            },
            access_mode: access_mode(owner),
        })
        .await
        .map_err(ToolExecutionError::Integrity)?;
    encoded(&result)
}
