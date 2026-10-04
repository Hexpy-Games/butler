use serde_json::{Value, json};

use crate::host::GuidedWorkTools;
use butler_core::json::JsonDocument;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{
    BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError, ToolJournalFinish,
    ToolJournalFinishStatus, ToolJournalRecord, ToolJournalStart, ToolResult,
};

use super::GuidedTools;
use super::occurrence::{Occurrence, occurrence};

pub(super) async fn execute(
    owner: &GuidedTools,
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
        resume.lock().discard(&call_id);
    } else if occurrence.provider_call_id.is_none() {
        let claimed = resume
            .lock()
            .claim(&effective_name, &presentation_args, catalog_id.as_deref())
            .map_err(ToolExecutionError::Integrity)?;
        if let Some(claimed) = claimed {
            record = owner
                .journal
                .find_for_turn(owner.binding.turn_id.clone(), claimed.clone())
                .await
                .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
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
                if GuidedWorkTools::repairs_completed_relation(&call.name)
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
            "failed" | "cancelled" => return prior_failure(&call.name, &record.status),
            "started" | "awaiting_authority"
                if !GuidedTools::supports(&call.name)
                    || matches!(
                        ToolName::parse(effective_name.as_str()),
                        Some(
                            ToolName::UpdateOnboardingProfile
                                | ToolName::IngestTaskMemory
                                | ToolName::UpdateExplicitMemory
                        )
                    ) =>
            {
                return uncertain_mutation(&effective_name);
            }
            _ => {}
        }
    }
    if record.is_none() {
        start(owner, call, &call_id, &effective_name, &presentation_args).await?;
    }
    let result = dispatch_result(owner, invocation, call, &call_id).await?;
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
            .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
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

async fn dispatch_result(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    #[cfg(debug_assertions)]
    hold_stub_tool(owner, call).await?;
    #[cfg(debug_assertions)]
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && std::env::var("BUTLER_E2E_INTERRUPT_TOOL").as_deref() == Ok(call.name.as_str())
        && tokio::fs::remove_file(owner.binding.butler_data.join("e2e-interrupt-tool"))
            .await
            .is_ok()
    {
        butler_core::diagnostic!(
            "[native-tool] interrupted turn_id={} session_id={} capability={} code=e2e_tool_integrity_failure Injected tool integrity failure.",
            owner.binding.turn_id,
            owner.binding.source_session_id,
            call.name
        );
        return Err(integrity("e2e_tool_integrity_failure"));
    }
    match Box::pin(super::question::dispatch(owner, invocation, call, call_id)).await {
        Ok(result) => Ok(result),
        Err(ToolExecutionError::Integrity(error)) if super::feedback::solvable(error.code()) => {
            super::feedback::result(&error)
        }
        Err(ToolExecutionError::Integrity(error)) => {
            butler_core::diagnostic!(
                "[native-tool] interrupted turn_id={} session_id={} capability={} code={} Tool execution could not safely continue.",
                owner.binding.turn_id,
                owner.binding.source_session_id,
                call.name,
                error.code()
            );
            Err(ToolExecutionError::Integrity(error))
        }
    }
}

#[cfg(debug_assertions)]
async fn hold_stub_tool(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<(), ToolExecutionError> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() != Ok("stub")
        || std::env::var("BUTLER_E2E_HOLD_TOOL").as_deref() != Ok(call.name.as_str())
    {
        return Ok(());
    }
    let hold = owner.binding.butler_data.join("e2e-hold-tool");
    if !tokio::fs::try_exists(&hold)
        .await
        .map_err(|_| integrity("e2e_tool_hold_failed"))?
    {
        return Ok(());
    }
    tokio::fs::write(
        owner.binding.butler_data.join("e2e-held-tool"),
        call.id.as_bytes(),
    )
    .await
    .map_err(|_| integrity("e2e_tool_hold_failed"))?;
    while tokio::fs::try_exists(&hold)
        .await
        .map_err(|_| integrity("e2e_tool_hold_failed"))?
    {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    Ok(())
}

pub(super) async fn record_unexecuted(
    owner: &GuidedTools,
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
        .activity
        .observe_tool(&owner.binding.turn_id, call, &call_id, invocation.progress)
        .await?;
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
        .map_err(BtccError::from)?;
    let body = serde_json::to_string(result).map_err(|error| {
        BtccError::relayed("guided_tool_result_json", error.to_string()).with_source(error)
    })?;
    owner
        .journal
        .finish(ToolJournalFinish {
            call_id,
            status: ToolJournalFinishStatus::Cancelled,
            result: Some(JsonDocument::from_encoded(body).map_err(|error| {
                BtccError::relayed("guided_tool_result_json", error.to_string()).with_source(error)
            })?),
            changed_files: None,
            error_code: None,
        })
        .await
        .map_err(BtccError::from)
}

fn next_index(owner: &GuidedTools) -> u64 {
    let mut state = owner.state.lock();
    let current = state.next_call_index;
    state.next_call_index += 1;
    current
}
fn remember_provider(owner: &GuidedTools, occurrence: &Occurrence, call_id: &str) {
    if let Some(provider) = &occurrence.provider_call_id {
        owner
            .state
            .lock()
            .journal_by_provider
            .insert(provider.clone(), call_id.into());
    }
}
async fn resolve_record(
    owner: &GuidedTools,
    occurrence: &Occurrence,
) -> Result<Option<ToolJournalRecord>, ToolExecutionError> {
    if let Some(record) = owner
        .journal
        .find_for_turn(owner.binding.turn_id.clone(), occurrence.call_id.clone())
        .await
        .map_err(|error| ToolExecutionError::Integrity(error.into()))?
    {
        return Ok(Some(record));
    }
    if let Some(legacy) = &occurrence.legacy_call_id {
        return owner
            .journal
            .find_for_turn(owner.binding.turn_id.clone(), legacy.clone())
            .await
            .map_err(|error| ToolExecutionError::Integrity(error.into()));
    }
    Ok(None)
}
async fn start(
    owner: &GuidedTools,
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
        .map_err(|error| ToolExecutionError::Integrity(error.into()))
}
async fn finish(
    owner: &GuidedTools,
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
        .map_err(|error| ToolExecutionError::Integrity(error.into()))
}
fn record_output(record: &ToolJournalRecord) -> Result<JsonDocument, ToolExecutionError> {
    record
        .result
        .clone()
        .ok_or_else(|| integrity("guided_tool_record_result_missing"))
}
fn prior_failure(name: &str, status: &str) -> Result<JsonDocument, ToolExecutionError> {
    let code = if status == "cancelled" {
        "prior_tool_call_cancelled"
    } else {
        "prior_tool_call_failed"
    };
    JsonDocument::from_value(&json!({"ok":false,"error":{"code":code,"message":format!(
        "The previous {name} call did not complete successfully. Adjust the call or continue with other evidence."
    )}})).map_err(|_| integrity("guided_tool_result_invalid"))
}
fn uncertain_mutation(name: &str) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(&json!({"ok":false,"error":{"code":"prior_mutation_completion_unknown",
        "message":format!("A previous {name} call may have changed external state, but its result was not durably recorded. Inspect the target before deciding whether another mutation is safe.")}}))
    .map_err(|_| integrity("guided_tool_result_invalid"))
}
fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value)
        .map_err(|error| integrity_message("guided_tool_result_json", error.to_string()))
}
fn integrity(code: &'static str) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::relayed(code, code))
}
fn integrity_message(code: &'static str, message: String) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::relayed(code, message))
}
