use std::collections::HashSet;

use crate::btcc::BtccCode;
use crate::btcc::BtccError;
use crate::public_text::trim_js_whitespace;

use super::contracts::{
    ActionProgress, ActionStatus, CheckpointInput, ClaimCloseoutCorrectionInput, ContinueWorkInput,
    DispositionActionUpdate, DispositionInput, DispositionStatus, PlanAction, ReplacePlanInput,
    ReviewInput, StartWorkInput, WorkTurnScope,
};

pub(crate) fn validate_scope(scope: &WorkTurnScope) -> Result<(), BtccError> {
    required_text(&scope.turn_id, "turnId")?;
    required_text(&scope.session_id, "sessionId")?;
    if let Some(project_ref) = scope.project_ref.as_deref() {
        required_text(project_ref, "projectRef")?;
    }
    Ok(())
}

pub(crate) fn validate_mutation(scope: &WorkTurnScope, call_id: &str) -> Result<(), BtccError> {
    validate_scope(scope)?;
    required_text(call_id, "mutationCallId")
}

pub(crate) fn validate_start(input: &StartWorkInput) -> Result<(), BtccError> {
    validate_mutation(&input.scope, &input.mutation_call_id)?;
    required_text(&input.objective, "objective")
}

pub(crate) fn validate_continue(input: &ContinueWorkInput) -> Result<(), BtccError> {
    validate_mutation(&input.scope, &input.mutation_call_id)?;
    required_text(&input.work_id, "workId")
}

pub(crate) fn validate_replace(input: &ReplacePlanInput) -> Result<(), BtccError> {
    validate_mutation(&input.scope, &input.mutation_call_id)?;
    required_text(&input.objective, "objective")?;
    if input.actions.is_empty() {
        return Err(error("Durable Work plan requires at least one action"));
    }
    for (index, check) in input.checks.iter().enumerate() {
        required_text(check, &format!("checks[{index}]"))?;
    }
    if let Some(refs) = input.governing_refs.as_deref() {
        for (index, reference) in refs.iter().enumerate() {
            required_text(reference, &format!("governingRefs[{index}]"))?;
        }
    }
    let mut keys = HashSet::with_capacity(input.actions.len());
    for (index, action) in input.actions.iter().enumerate() {
        required_text(&action.action_key, &format!("actions[{index}].actionKey"))?;
        required_text(
            &action.description,
            &format!("actions[{index}].description"),
        )?;
        if !keys.insert(action.action_key.as_str()) {
            return Err(error(format!(
                "Durable Work actionKey is duplicated: {}",
                action.action_key
            )));
        }
        validate_plan_action(action, index)?;
    }
    for action in &input.actions {
        for dependency in &action.dependency_keys {
            if !keys.contains(dependency.as_str()) {
                return Err(error(format!(
                    "Durable Work action dependency is missing: {} -> {}",
                    action.action_key, dependency
                )));
            }
            if dependency == &action.action_key {
                return Err(error(format!(
                    "Durable Work action cannot depend on itself: {}",
                    action.action_key
                )));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_checkpoint(input: &CheckpointInput) -> Result<(), BtccError> {
    validate_mutation(&input.scope, &input.mutation_call_id)?;
    let updates = input.action_updates.as_deref().unwrap_or(&[]);
    if input.next_stage.is_none()
        && updates.is_empty()
        && input
            .public_summary
            .as_deref()
            .is_none_or(|value| trim_js_whitespace(value).is_empty())
        && input
            .next_step
            .as_deref()
            .is_none_or(|value| trim_js_whitespace(value).is_empty())
    {
        return Err(error(
            "Durable Work progress requires a stage, action update, or summary",
        ));
    }
    validate_action_updates(updates)
}

pub(crate) fn validate_review(input: &ReviewInput) -> Result<(), BtccError> {
    validate_mutation(&input.scope, &input.mutation_call_id)?;
    required_text(&input.summary, "summary")?;
    for (index, correction) in input.corrections.iter().enumerate() {
        required_text(correction, &format!("corrections[{index}]"))?;
    }
    validate_action_updates(input.action_updates.as_deref().unwrap_or(&[]))
}

pub(crate) fn validate_disposition(input: &DispositionInput) -> Result<(), BtccError> {
    validate_mutation(&input.scope, &input.mutation_call_id)?;
    required_text(&input.work_id, "workId")?;
    required_text(&input.summary, "summary")?;
    if let Some(fingerprint) = input.expected_material_fingerprint.as_deref()
        && !is_lower_hex_sha256(fingerprint)
    {
        return Err(error(
            "Durable Work expected material fingerprint is invalid",
        ));
    }
    if let Some(generation) = input.runtime_owned_open_generation.as_ref()
        && (generation.version != 1
            || input.disposition != DispositionStatus::Open
            || input.expected_material_fingerprint.is_none())
    {
        return Err(error("Runtime-owned open requires its material generation"));
    }
    validate_disposition_updates(input.action_updates.as_deref().unwrap_or(&[]))?;
    validate_text_list(
        input.remaining_actions.as_deref().unwrap_or(&[]),
        "remainingActions",
    )?;
    validate_text_list(
        input.evidence_refs.as_deref().unwrap_or(&[]),
        "evidenceRefs",
    )?;
    validate_text_list(input.followups.as_deref().unwrap_or(&[]), "followups")?;
    if let Some(condition) = input.next_condition.as_deref() {
        required_text(condition, "nextCondition")?;
    }
    Ok(())
}

pub(crate) fn validate_closeout_missing(
    input: &ClaimCloseoutCorrectionInput,
) -> Result<(), BtccError> {
    validate_scope(&input.scope)?;
    required_text(&input.work_id, "workId")
}

pub(crate) fn required_text(value: &str, field: &str) -> Result<(), BtccError> {
    if trim_js_whitespace(value).is_empty() {
        Err(error(format!("Durable Work requires {field}")))
    } else {
        Ok(())
    }
}

fn validate_plan_action(action: &PlanAction, index: usize) -> Result<(), BtccError> {
    for (dependency_index, dependency) in action.dependency_keys.iter().enumerate() {
        required_text(
            dependency,
            &format!("actions[{index}].dependencyKeys[{dependency_index}]"),
        )?;
    }
    if let Some(effect) = action
        .effect
        .as_ref()
        .filter(|value| effect_is_truthy(value))
    {
        required_text(
            effect
                .get("capability")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
            &format!("actions[{index}].effect.capability"),
        )?;
        required_text(
            effect
                .get("target")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
            &format!("actions[{index}].effect.target"),
        )?;
    }
    Ok(())
}

fn effect_is_truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(value) => value.as_f64() != Some(0.0),
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

fn validate_action_updates(updates: &[ActionProgress]) -> Result<(), BtccError> {
    let mut keys = HashSet::with_capacity(updates.len());
    for (index, update) in updates.iter().enumerate() {
        required_text(
            &update.action_key,
            &format!("actionUpdates[{index}].actionKey"),
        )?;
        if !keys.insert(update.action_key.as_str()) {
            return Err(error(format!(
                "Durable Work action update is duplicated: {}",
                update.action_key
            )));
        }
        if let Some(note) = update.note.as_deref() {
            required_text(note, &format!("actionUpdates[{index}].note"))?;
        }
    }
    Ok(())
}

fn validate_disposition_updates(updates: &[DispositionActionUpdate]) -> Result<(), BtccError> {
    let mut keys = HashSet::with_capacity(updates.len());
    for (index, update) in updates.iter().enumerate() {
        required_text(
            &update.action_key,
            &format!("actionUpdates[{index}].actionKey"),
        )?;
        if !keys.insert(update.action_key.as_str()) {
            return Err(error(format!(
                "Durable Work action update is duplicated: {}",
                update.action_key
            )));
        }
        if !matches!(
            update.status,
            ActionStatus::Done | ActionStatus::Skipped | ActionStatus::Blocked
        ) {
            return Err(error(format!(
                "Unsupported Work disposition action status: {}",
                action_status_name(update.status)
            )));
        }
        if let Some(note) = update.note.as_deref() {
            required_text(note, &format!("actionUpdates[{index}].note"))?;
        }
    }
    Ok(())
}

fn validate_text_list(values: &[String], field: &str) -> Result<(), BtccError> {
    for (index, value) in values.iter().enumerate() {
        required_text(value, &format!("{field}[{index}]"))?;
    }
    Ok(())
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn action_status_name(status: ActionStatus) -> &'static str {
    match status {
        ActionStatus::Pending => "pending",
        ActionStatus::Active => "active",
        ActionStatus::Done => "done",
        ActionStatus::Blocked => "blocked",
        ActionStatus::Skipped => "skipped",
    }
}

fn error(message: impl Into<String>) -> BtccError {
    BtccError::detected(BtccCode::DurableWorkValidation, message)
}

#[cfg(test)]
mod tests;
