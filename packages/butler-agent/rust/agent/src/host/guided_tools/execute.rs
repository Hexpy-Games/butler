use serde_json::{Value, json};

use crate::btcc::{
    BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError, ToolResult,
};
use crate::btcc::{
    ToolJournalFinish, ToolJournalFinishStatus, ToolJournalRecord, ToolJournalStart,
};
use crate::host::NativeGuidedWorkTools;
use crate::json::JsonDocument;

use super::NativeGuidedTools;
use super::occurrence::{Occurrence, occurrence};

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    owner
        .same_turn(invocation)
        .map_err(ToolExecutionError::Integrity)?;
    if invocation.cancellation.is_cancelled() {
        return Err(integrity("turn_cancelled"));
    }
    let index = next_index(owner);
    let (effective_name, presentation_args, catalog_id) = super::discovery::effective(call);
    let occurrence = occurrence(&owner.binding.turn_id, index, call)
        .map_err(|error| ToolExecutionError::Integrity(error.contract()))?;
    let mut record = resolve_record(owner, &occurrence).await?;
    let mut call_id = record.as_ref().map_or_else(
        || occurrence.call_id.clone(),
        |record| record.call_id.clone(),
    );
    let resume = owner
        .resume_pool()
        .await
        .map_err(ToolExecutionError::Integrity)?;
    if record.is_some() {
        resume
            .lock()
            .expect("guided resume pool poisoned")
            .discard(&call_id);
    } else if occurrence.provider_call_id.is_none() {
        let claimed = resume
            .lock()
            .expect("guided resume pool poisoned")
            .claim(&effective_name, &presentation_args, catalog_id.as_deref())
            .map_err(ToolExecutionError::Integrity)?;
        if let Some(claimed) = claimed {
            record = owner
                .journal
                .find_for_turn(owner.binding.turn_id.clone(), claimed.clone())
                .await
                .map_err(|error| {
                    ToolExecutionError::Integrity(BtccError::new(error.code, error.message))
                })?;
            if record.is_none() {
                return Err(integrity("guided_tool_resume_record_missing"));
            }
            call_id = claimed;
        }
    }
    remember_provider(owner, &occurrence, &call_id);
    owner
        .activity
        .observe_tool(&owner.binding.turn_id, call, &call_id, invocation.progress)
        .await
        .map_err(ToolExecutionError::Integrity)?;
    if !owner.binding.visible_names.contains(&call.name)
        || !owner.binding.authorized_names.contains(&call.name)
    {
        let denied = json!({"ok":false,"error":{"code":"tool_not_authorized",
            "message":format!("{} is not available for this Turn. Use an available tool or continue with known facts.",call.name)}});
        let denied = encoded(&denied)?;
        if record.is_none() {
            start(owner, call, &call_id, &effective_name, &presentation_args).await?;
            finish(
                owner,
                &call_id,
                ToolJournalFinishStatus::Completed,
                Some(&denied),
            )
            .await?;
        }
        return match record.as_ref().filter(|record| record.result.is_some()) {
            Some(record) => record_output(record),
            None => Ok(denied),
        };
    }
    if let Some(record) = record.as_ref() {
        match record.status.as_str() {
            "completed" => {
                let output = record_output(record)?;
                super::discovery::remember_described(owner, call, &output)?;
                if NativeGuidedWorkTools::repairs_completed_relation(&call.name)
                    && output.field("ok").ok().flatten() == Some("true")
                {
                    let repaired = super::dispatch::execute_work(owner, call, &call_id).await?;
                    if repaired.get("ok") != Some(&Value::Bool(true)) {
                        return Err(integrity("guided_work_relation_repair_failed"));
                    }
                }
                super::dispatch::publish_work_result(
                    owner, invocation, &call.name, &call_id, &output,
                )
                .await?;
                return Ok(output);
            }
            "failed" | "cancelled" => return Ok(prior_failure(&call.name, &record.status)),
            "started" | "awaiting_authority"
                if !NativeGuidedTools::supports(&call.name)
                    || matches!(
                        effective_name.as_str(),
                        "update_onboarding_profile"
                            | "ingest_task_memory"
                            | "update_explicit_memory"
                    ) =>
            {
                return Ok(uncertain_mutation(&effective_name));
            }
            _ => {}
        }
    }
    if record.is_none() {
        start(owner, call, &call_id, &effective_name, &presentation_args).await?;
    }
    let result = super::dispatch::execute(owner, invocation, call, &call_id).await?;
    super::discovery::remember_described(owner, call, &result)?;
    if result.field("authority_pending").ok().flatten() == Some("true") {
        // Authority admission atomically moved this call to awaiting_authority.
        // The loop persists the pending result in its continuation, not as a
        // completed tool-journal result before a decision exists.
        return Ok(result);
    }
    if invocation.cancellation.is_cancelled() {
        owner
            .journal
            .finish(ToolJournalFinish {
                call_id,
                status: ToolJournalFinishStatus::Cancelled,
                result: None,
                changed_files: None,
                error_code: Some("cancelled".into()),
            })
            .await
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::new(error.code, error.message))
            })?;
        return Err(integrity("turn_cancelled"));
    }
    finish(
        owner,
        &call_id,
        ToolJournalFinishStatus::Completed,
        Some(&result),
    )
    .await?;
    super::dispatch::publish_work_result(owner, invocation, &call.name, &call_id, &result).await?;
    Ok(result)
}

pub(super) async fn record_unexecuted(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    result: &ToolResult,
) -> Result<(), BtccError> {
    owner.same_turn(invocation)?;
    let index = next_index(owner);
    let occurrence = occurrence(&owner.binding.turn_id, index, call)
        .map_err(super::GuidedToolError::contract)?;
    let call_id = occurrence.call_id.clone();
    remember_provider(owner, &occurrence, &call_id);
    owner
        .journal
        .start(ToolJournalStart {
            turn_id: owner.binding.turn_id.clone(),
            call_id: call_id.clone(),
            tool_name: call.name.clone(),
            raw_arguments: call.raw_arguments.clone(),
            arguments: Value::Object(call.arguments.clone()),
        })
        .await
        .map_err(|error| BtccError::new(error.code, error.message))?;
    let body = serde_json::to_string(result)
        .map_err(|error| BtccError::new("guided_tool_result_json", error.to_string()))?;
    owner
        .journal
        .finish(ToolJournalFinish {
            call_id,
            status: ToolJournalFinishStatus::Cancelled,
            result: Some(
                JsonDocument::from_encoded(body).map_err(|error| {
                    BtccError::new("guided_tool_result_json", error.to_string())
                })?,
            ),
            changed_files: None,
            error_code: None,
        })
        .await
        .map_err(|error| BtccError::new(error.code, error.message))
}

fn next_index(owner: &NativeGuidedTools) -> u64 {
    let mut state = owner.state.lock().expect("guided tool state poisoned");
    let current = state.next_call_index;
    state.next_call_index += 1;
    current
}
fn remember_provider(owner: &NativeGuidedTools, occurrence: &Occurrence, call_id: &str) {
    if let Some(provider) = &occurrence.provider_call_id {
        owner
            .state
            .lock()
            .expect("guided tool state poisoned")
            .journal_by_provider
            .insert(provider.clone(), call_id.into());
    }
}
async fn resolve_record(
    owner: &NativeGuidedTools,
    occurrence: &Occurrence,
) -> Result<Option<ToolJournalRecord>, ToolExecutionError> {
    if let Some(record) = owner
        .journal
        .find_for_turn(owner.binding.turn_id.clone(), occurrence.call_id.clone())
        .await
        .map_err(|error| ToolExecutionError::Integrity(BtccError::new(error.code, error.message)))?
    {
        return Ok(Some(record));
    }
    if let Some(legacy) = &occurrence.legacy_call_id {
        return owner
            .journal
            .find_for_turn(owner.binding.turn_id.clone(), legacy.clone())
            .await
            .map_err(|error| {
                ToolExecutionError::Integrity(BtccError::new(error.code, error.message))
            });
    }
    Ok(None)
}
async fn start(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
    call_id: &str,
    effective_name: &str,
    presentation_args: &Value,
) -> Result<(), ToolExecutionError> {
    owner
        .journal
        .start(ToolJournalStart {
            turn_id: owner.binding.turn_id.clone(),
            call_id: call_id.into(),
            tool_name: effective_name.into(),
            raw_arguments: call.raw_arguments.clone(),
            arguments: presentation_args.clone(),
        })
        .await
        .map_err(|error| ToolExecutionError::Integrity(BtccError::new(error.code, error.message)))
}
async fn finish(
    owner: &NativeGuidedTools,
    call_id: &str,
    status: ToolJournalFinishStatus,
    result: Option<&JsonDocument>,
) -> Result<(), ToolExecutionError> {
    owner
        .journal
        .finish(ToolJournalFinish {
            call_id: call_id.into(),
            status,
            result: result.cloned(),
            changed_files: None,
            error_code: None,
        })
        .await
        .map_err(|error| ToolExecutionError::Integrity(BtccError::new(error.code, error.message)))
}
fn record_output(record: &ToolJournalRecord) -> Result<JsonDocument, ToolExecutionError> {
    record
        .result
        .clone()
        .ok_or_else(|| integrity("guided_tool_record_result_missing"))
}
fn prior_failure(name: &str, status: &str) -> JsonDocument {
    let code = if status == "cancelled" {
        "prior_tool_call_cancelled"
    } else {
        "prior_tool_call_failed"
    };
    JsonDocument::from_value(&json!({"ok":false,"error":{"code":code,"message":format!(
        "The previous {name} call did not complete successfully. Adjust the call or continue with other evidence."
    )}})).expect("static failure result")
}
fn uncertain_mutation(name: &str) -> JsonDocument {
    JsonDocument::from_value(&json!({"ok":false,"error":{"code":"prior_mutation_completion_unknown",
        "message":format!("A previous {name} call may have changed external state, but its result was not durably recorded. Inspect the target before deciding whether another mutation is safe.")}}))
    .expect("static uncertain result")
}
fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value)
        .map_err(|error| integrity_message("guided_tool_result_json", error.to_string()))
}
fn integrity(code: &'static str) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::new(code, code))
}
fn integrity_message(code: &'static str, message: String) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::new(code, message))
}
