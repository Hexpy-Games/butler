//! Structural Task contracts and exact registered keys.
use super::*;
pub(in crate::btcc::subsessions::service) fn validate(
    task: &mut TaskContract,
    plan: &crate::btcc::WorkPlan,
) -> Option<Value> {
    let mut missing = Vec::new();
    if task
        .scope
        .as_ref()
        .is_none_or(|s| s.owns.is_empty() && s.paths.is_empty())
    {
        missing.push("task.scope");
    }
    if task.output.as_ref().is_none_or(|o| {
        butler_core::public_text::trim_js_whitespace(&o.format).is_empty()
            || o.fields.is_empty() && o.files.is_empty()
    }) {
        missing.push("task.output");
    }
    if !missing.is_empty() {
        return Some(refusal("task_fields_required", json!({"fields":missing})));
    }
    let scope = task.scope.as_mut()?;
    let registered: Vec<_> = plan.subjects.iter().map(|s| s.key.as_str()).collect();
    let unknown: Vec<_> = scope
        .owns
        .iter()
        .filter(|s| !registered.contains(&s.subject.as_str()))
        .map(|s| &s.subject)
        .collect();
    if !unknown.is_empty() {
        return Some(refusal(
            "task_subject_unknown",
            json!({"unknown":unknown,"registered":registered}),
        ));
    }
    for path in &mut scope.paths {
        let Some(normalized) = task_path(path) else {
            return Some(refusal("task_path_invalid", json!(path)));
        };
        *path = normalized;
    }
    if task.inputs.iter().any(|i| {
        i.usage == TaskInputUse::Verify
            && i.reason
                .as_ref()
                .is_none_or(|r| butler_core::public_text::trim_js_whitespace(r).is_empty())
    }) {
        return Some(refusal(
            "task_verify_reason_required",
            json!({"fields":["task.inputs.reason"]}),
        ));
    }
    None
}

pub(super) fn check_inputs(task: &TaskContract, tasks: &[WorkTask]) -> Option<Value> {
    for input in &task.inputs {
        if !tasks.iter().any(|t| {
            t.task_id == input.task
                && (t.status == "done" && t.result_ref.is_some()
                    || matches!(t.status.as_str(), "pending" | "active"))
        }) {
            return Some(refusal("task_input_not_done", json!({"task":input.task})));
        }
    }
    for id in &task.merge_after {
        if !tasks.iter().any(|t| &t.task_id == id) {
            return Some(refusal("task_dependency_unknown", json!(id)));
        }
    }
    None
}

pub(super) fn replacement(
    task: &TaskContract,
    tasks: &[WorkTask],
    relation: Option<&str>,
    action: &str,
) -> Option<Value> {
    let id = relation?;
    let Some(old) = tasks
        .iter()
        .find(|t| t.relation_id == id && t.action_key == action)
    else {
        return Some(refusal("task_replacement_missing", json!(id)));
    };
    if !matches!(old.status.as_str(), "pending" | "active") {
        return Some(refusal(
            "task_replacement_not_running",
            json!({"task":old.task_id,"status":old.status}),
        ));
    }
    if task.scope.as_ref() != Some(&old.scope) {
        return Some(refusal(
            "task_replacement_scope_mismatch",
            json!({"task":old.task_id,"scope":old.scope}),
        ));
    }
    None
}
