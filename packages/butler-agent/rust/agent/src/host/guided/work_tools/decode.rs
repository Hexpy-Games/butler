//! Model snake_case arguments translated at the source Work tool boundary.

use serde_json::{Map, Value, json};

use crate::btcc::{
    ActionProgress, ActionStatus, CheckpointInput, ContinueWorkInput, CorrectionScope,
    DispositionActionUpdate, DispositionInput, DispositionStatus, ExecutionMode, PlanAction,
    ReplacePlanInput, ReviewInput, ReviewSubject, ReviewVerdict, StartWorkInput, WorkTurnScope,
};

pub(super) enum Command {
    Start(StartWorkInput),
    Continue(ContinueWorkInput),
    Replace(ReplacePlanInput),
    Checkpoint(CheckpointInput),
    Review(ReviewInput),
    Disposition(DispositionInput),
}

pub(super) fn command(
    name: &str,
    args: &Map<String, Value>,
    scope: WorkTurnScope,
    mutation_call_id: &str,
    prior_tool_call_ids: &[String],
    expected_material_fingerprint: Option<&str>,
) -> Result<Command, String> {
    let id = mutation_call_id.to_owned();
    let backfill = (!prior_tool_call_ids.is_empty()).then(|| prior_tool_call_ids.to_vec());
    Ok(match name {
        "start_work" => Command::Start(StartWorkInput {
            scope,
            mutation_call_id: id,
            objective: required(args.get("objective"), "objective")?,
            backfill_tool_call_ids: backfill,
        }),
        "continue_work" => Command::Continue(ContinueWorkInput {
            scope,
            mutation_call_id: id,
            work_id: required(args.get("work_id"), "work_id")?,
            backfill_tool_call_ids: backfill,
        }),
        "replace_work_plan" => {
            let actions = nonempty_array(args.get("actions"), "actions")?
                .iter()
                .enumerate()
                .map(|(index, value)| action(value, index))
                .collect::<Result<Vec<_>, _>>()?;
            Command::Replace(ReplacePlanInput {
                scope,
                mutation_call_id: id,
                start_new: Some(boolean(args.get("start_new"), "start_new")?),
                backfill_tool_call_ids: backfill,
                objective: required(args.get("objective"), "objective")?,
                governing_refs: Some(strings(args.get("governing_refs"), "governing_refs")?),
                execution_mode: Some(execution_mode(args.get("execution_mode"))?),
                actions,
                checks: strings(args.get("checks"), "checks")?,
            })
        }
        "record_work_checkpoint" => Command::Checkpoint(CheckpointInput {
            scope,
            mutation_call_id: id,
            next_stage: None,
            action_updates: Some(action_updates(args.get("action_updates"))?),
            public_summary: optional(args.get("public_summary")),
            next_step: optional(args.get("next_step")),
        }),
        "record_work_review" => Command::Review(ReviewInput {
            scope,
            mutation_call_id: id,
            subject: review_subject(args.get("subject"))?,
            verdict: review_verdict(args.get("verdict"))?,
            summary: required(args.get("summary"), "summary")?,
            corrections: strings(args.get("corrections"), "corrections")?,
            action_updates: Some(action_updates(args.get("action_updates"))?),
            correction_scope: correction_scope(args.get("correction_scope"))?,
            next_stage: None,
        }),
        "record_work_disposition" => Command::Disposition(DispositionInput {
            scope,
            mutation_call_id: id,
            work_id: required(args.get("work_id"), "work_id")?,
            disposition: disposition(args.get("disposition"))?,
            summary: required(args.get("summary"), "summary")?,
            action_updates: Some(disposition_updates(args.get("action_updates"))?),
            remaining_actions: Some(strings(args.get("remaining_actions"), "remaining_actions")?),
            next_condition: optional(args.get("next_condition")),
            evidence_refs: backfill.clone(),
            followups: Some(strings(args.get("followups"), "followups")?),
            backfill_tool_call_ids: backfill,
            expected_material_fingerprint: expected_material_fingerprint.map(str::to_owned),
            runtime_owned_open_generation: None,
        }),
        _ => return Err(format!("Unsupported Work tool: {name}")),
    })
}

fn trim(value: &str) -> &str {
    crate::public_text::trim_js_whitespace(value)
}
fn required(value: Option<&Value>, field: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Work update requires {field}"))
}
fn optional(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn array<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a [Value], String> {
    match value {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err(format!("Work update requires {field} to be an array")),
    }
}
fn nonempty_array<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a [Value], String> {
    match value {
        Some(Value::Array(values)) if !values.is_empty() => Ok(values),
        _ => Err(format!("Work update requires at least one {field} entry")),
    }
}
fn strings(value: Option<&Value>, field: &str) -> Result<Vec<String>, String> {
    array(value, field)?
        .iter()
        .enumerate()
        .map(|(index, item)| required(Some(item), &format!("{field}[{index}]")))
        .collect()
}
fn object<'a>(value: &'a Value, field: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("Work update requires {field} to be an object"))
}
fn boolean(value: Option<&Value>, field: &str) -> Result<bool, String> {
    match value {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(format!("Work update requires {field} to be boolean")),
    }
}
fn execution_mode(value: Option<&Value>) -> Result<ExecutionMode, String> {
    match value.and_then(Value::as_str) {
        Some("direct") => Ok(ExecutionMode::Direct),
        Some("steward") => Ok(ExecutionMode::Steward),
        Some("workers") => Ok(ExecutionMode::Workers),
        _ => Err("Work Plan requires execution_mode to be direct, steward or workers".into()),
    }
}
fn action(value: &Value, index: usize) -> Result<PlanAction, String> {
    let record = object(value, &format!("actions[{index}]"))?;
    let key = required(
        record.get("action_key"),
        &format!("actions[{index}].action_key"),
    )?;
    let effect = record
        .get("effect")
        .map(|effect| {
            let effect = object(effect, &format!("actions[{index}].effect"))?;
            Ok::<_, String>(json!({
                "capability":required(effect.get("capability"), &format!("actions[{index}].effect.capability"))?,
                "target":required(effect.get("target"), &format!("actions[{index}].effect.target"))?,
            }))
        })
        .transpose()?;
    Ok(PlanAction {
        action_key: key.clone(),
        description: optional(record.get("description")).unwrap_or(key),
        dependency_keys: strings(
            record.get("dependency_keys"),
            &format!("actions[{index}].dependency_keys"),
        )?,
        effect,
    })
}
fn status(value: Option<&Value>, field: &str) -> Result<ActionStatus, String> {
    let status = required(value, field)?;
    match status.as_str() {
        "pending" => Ok(ActionStatus::Pending),
        "active" => Ok(ActionStatus::Active),
        "done" => Ok(ActionStatus::Done),
        "blocked" => Ok(ActionStatus::Blocked),
        "skipped" => Ok(ActionStatus::Skipped),
        _ => Err(format!("Unsupported Work action status: {status}")),
    }
}
fn action_updates(value: Option<&Value>) -> Result<Vec<ActionProgress>, String> {
    array(value, "action_updates")?
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let item = object(item, &format!("action_updates[{index}]"))?;
            Ok(ActionProgress {
                action_key: required(
                    item.get("action_key"),
                    &format!("action_updates[{index}].action_key"),
                )?,
                status: status(
                    item.get("status"),
                    &format!("action_updates[{index}].status"),
                )?,
                note: optional(item.get("note")),
            })
        })
        .collect()
}
fn disposition_updates(value: Option<&Value>) -> Result<Vec<DispositionActionUpdate>, String> {
    let values = match value {
        None => &[][..],
        Some(Value::Array(values)) => values.as_slice(),
        _ => return Err("Work disposition requires action_updates to be an array".into()),
    };
    values
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let item = object(item, &format!("action_updates[{index}]"))?;
            let text = required(
                item.get("status"),
                &format!("action_updates[{index}].status"),
            )?;
            let parsed = match text.as_str() {
                "done" => ActionStatus::Done,
                "skipped" => ActionStatus::Skipped,
                "blocked" => ActionStatus::Blocked,
                _ => {
                    return Err(format!(
                        "Unsupported Work disposition action status: {text}"
                    ));
                }
            };
            Ok(DispositionActionUpdate {
                action_key: required(
                    item.get("action_key"),
                    &format!("action_updates[{index}].action_key"),
                )?,
                status: parsed,
                note: optional(item.get("note")),
            })
        })
        .collect()
}
fn review_subject(value: Option<&Value>) -> Result<ReviewSubject, String> {
    let subject = required(value, "subject")?;
    match subject.as_str() {
        "plan" => Ok(ReviewSubject::Plan),
        "result" => Ok(ReviewSubject::Result),
        "completion" => Ok(ReviewSubject::Completion),
        _ => Err(format!("Unsupported Work review subject: {subject}")),
    }
}
fn review_verdict(value: Option<&Value>) -> Result<ReviewVerdict, String> {
    let verdict = required(value, "verdict")?;
    match verdict.as_str() {
        "accept" => Ok(ReviewVerdict::Accept),
        "revise" => Ok(ReviewVerdict::Revise),
        "partial" => Ok(ReviewVerdict::Partial),
        _ => Err(format!("Unsupported Work review verdict: {verdict}")),
    }
}
fn correction_scope(value: Option<&Value>) -> Result<Option<CorrectionScope>, String> {
    let Some(value) = optional(value) else {
        return Ok(None);
    };
    match value.as_str() {
        "planning" => Ok(Some(CorrectionScope::Planning)),
        "execution" => Ok(Some(CorrectionScope::Execution)),
        _ => Err(format!("Unsupported Work correction scope: {value}")),
    }
}
fn disposition(value: Option<&Value>) -> Result<DispositionStatus, String> {
    let value = required(value, "disposition")?;
    match value.as_str() {
        "completed" => Ok(DispositionStatus::Completed),
        "open" => Ok(DispositionStatus::Open),
        "blocked" => Ok(DispositionStatus::Blocked),
        _ => Err(format!("Unsupported Work disposition: {value}")),
    }
}
