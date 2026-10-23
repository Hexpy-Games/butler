//! Authored model-facing rejection messages; access policy stays independent.
use super::*;
use crate::store::model_text;

pub(super) fn canon() -> Value {
    json!({"ok":false,"error":{"code":"canon_write_forbidden","message":"work_apply cannot create canon items or change visibility. Remove that operation or field and continue on this Work; sharing is the person's action."}})
}
pub(super) fn response(
    db: &Connection,
    scope: &ApplyScope,
    error: &Error,
    op: Option<&Operation>,
) -> Result<Value> {
    let target = target(op).unwrap_or("unknown");
    let (code, message) = message(error, target);
    let work = scope
        .work_id
        .as_deref()
        .map(|id| read_work(db, id))
        .transpose()?;
    Ok(json!({"ok":false,"error":{"code":code,"message":message},"work":work}))
}
fn message(error: &Error, target: &str) -> (&'static str, String) {
    match error {
        Error::ImpactIncomplete(ids) => (
            "impact_map_incomplete",
            format!(
                "impact_map is missing Tasks bound to changed criteria: {}. Add an entry for each and resend.",
                ids.join(", ")
            ),
        ),
        Error::Conflict { current } => conflict_rejection(current, target),
        Error::Invalid("stale_owner") => (
            "stale_owner",
            format!(
                "This session no longer owns Task {target}; it moved to another conversation, and your change was not applied. Stop working on this Task, do not resend, and call work_read view=tasks before doing anything else."
            ),
        ),
        Error::Invalid("tier1_floor_exceeded") => {
            ("tier1_floor_exceeded", model_text::TIER1_FLOOR.into())
        }
        Error::Invalid("no_started_task") => {
            ("no_started_task", model_text::NO_STARTED_TASK.into())
        }
        Error::Running => (
            "task_running_pinned",
            format!(
                "Task {target} is running, so it cannot be moved, merged, split or deleted. Place the other Tasks around it, or make this change after it ends."
            ),
        ),
        Error::NotFound if target != "unknown" => (
            "unknown_task",
            format!(
                "No Task {target} in this Work. Use an id from work_read view=tasks, or a @key defined earlier in this batch."
            ),
        ),
        Error::PartCycle { task, path } => (
            "part_cycle",
            format!(
                "after_part_ids would create a cycle among parts of Task {task} ({}). Remove one of those links.",
                path.join(" -> ")
            ),
        ),
        Error::Chain(detail) => (
            "planner_constraint_violation",
            format!(
                "Tasks must form chains of steps, each step one Task or a flat stack; {detail} breaks that. No nested stacks, parallel sub-chains or links between chains. Write this breakdown as parts of one Task with part.add, ordered with after_part_ids, and keep integrate and review as parts."
            ),
        ),
        Error::Invalid("completed Task cannot be deleted") => (
            "task_completed_kept",
            format!(
                "Completed Tasks stay in the Work. Leave Task {target} as it is and add a new Task for any change."
            ),
        ),
        Error::Invalid("draft_unresolved") => (
            "draft_unresolved",
            format!(
                "Task {target} is a draft from a queued message. Resolve it first: confirm it with acceptance_refs, fold it into a Task as parts, or delete it."
            ),
        ),
        Error::Invalid("review_not_accepted") => (
            "review_not_accepted",
            format!(
                "Task {target} has no accepted review at its current result revision. Submit the result, record task.review for every bound criterion, then complete."
            ),
        ),
        Error::Invalid("placement_ambiguous") => (
            "placement_ambiguous",
            r#"Give exactly one of after_task_id, join_step_of_task_id or step:"new"."#.into(),
        ),
        _ => (
            "work_apply_rejected",
            model_text::rejected(&error.to_string()),
        ),
    }
}

fn target(op: Option<&Operation>) -> Option<&str> {
    match op? {
        Operation::Edit { task_id, .. }
        | Operation::Move { task_id, .. }
        | Operation::JoinStack { task_id, .. }
        | Operation::SplitStack { task_id, .. }
        | Operation::Delete { task_id, .. }
        | Operation::PartAdd { task_id, .. }
        | Operation::Start { task_id }
        | Operation::Submit { task_id, .. }
        | Operation::Review { task_id, .. }
        | Operation::Complete { task_id, .. }
        | Operation::Block { task_id, .. }
        | Operation::Fail { task_id, .. } => Some(task_id),
        _ => None,
    }
}

fn conflict_rejection(current: &Value, target: &str) -> (&'static str, String) {
    match current {
        current if current.get("instruction_id").is_some() => (
            "instruction_pending",
            model_text::INSTRUCTION_PENDING.to_owned(),
        ),
        current if current.get("task_graph_revision").is_some() => {
            let n = &current["task_graph_revision"];
            (
                "stale_task_graph_revision",
                format!(
                    "The Task layout changed after your read (now revision {n}). Call work_read view=tasks, re-plan against the current steps, and resend with expected_task_graph_revision={n}."
                ),
            )
        }
        current if current.get("revision").and_then(Value::as_i64).is_some() => {
            let entity = if current.get("part_rank").is_some() {
                "part"
            } else if current.get("node_id").is_some() {
                "Spec"
            } else {
                "Task"
            };
            let id = current
                .get("id")
                .or_else(|| current.get("node_id"))
                .and_then(Value::as_str)
                .unwrap_or(target);
            (
                "stale_entity_revision",
                model_text::stale(entity, id, current["revision"].as_i64().unwrap_or_default()),
            )
        }
        current => ("conflict", model_text::conflict(&current.to_string())),
    }
}
