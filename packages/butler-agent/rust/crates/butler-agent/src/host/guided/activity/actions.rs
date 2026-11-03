//! Explicit action correlation; display text and tool names never identify an action.
use super::State;
use butler_turn::btcc::{ActionStatus, ModelRoundToolCall, ReviewVerdict, WorkStage, WorkView};
use serde_json::{Map, Value, json};

pub(super) fn fallback(work: &WorkView) -> Option<String> {
    let plan = work.current_plan.as_ref()?;
    if !work.latest_plan_review.as_ref().is_some_and(|review| {
        review.verdict == ReviewVerdict::Accept
            && review.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
    }) {
        return None;
    }
    let mut active = work
        .action_progress
        .iter()
        .filter(|p| p.status == ActionStatus::Active);
    let key = active.next()?.action_key.clone();
    active.next().is_none().then_some(key)
}

pub(super) fn group(
    state: &State,
    call: &ModelRoundToolCall,
    stage: Option<WorkStage>,
) -> Map<String, Value> {
    let mut fields = Map::new();
    // Planning and conception describe the whole plan even during a revision.
    if matches!(stage, Some(WorkStage::Planning | WorkStage::Conception)) {
        fields.insert("planLevel".into(), json!(true));
        return fields;
    }
    if call.name == "record_work_review"
        && call.arguments.get("subject").and_then(Value::as_str) == Some("plan")
    {
        fields.insert("planLevel".into(), json!(true));
        return fields;
    }
    let selected = selection(call);
    if selected.is_some() {
        fields.insert("setsCurrentAction".into(), json!(true));
    }
    if let Some(key) = selected.or_else(|| state.current_action.clone()) {
        fields.insert("actionKey".into(), json!(key));
    }
    fields
}

fn selection(call: &ModelRoundToolCall) -> Option<String> {
    let field = match call.name.as_str() {
        "continue_work" => "action_key",
        "record_work_checkpoint" => "current_action_key",
        _ => return None,
    };
    if let Some(key) = call.arguments.get(field).and_then(Value::as_str) {
        return Some(butler_core::public_text::trim_js_whitespace(key).to_owned());
    }
    if call.name != "record_work_checkpoint" {
        return None;
    }
    let mut active = call
        .arguments
        .get("action_updates")?
        .as_array()?
        .iter()
        .filter(|p| p["status"] == "active");
    let key = butler_core::public_text::trim_js_whitespace(active.next()?["action_key"].as_str()?)
        .to_owned();
    active.next().is_none().then_some(key)
}

pub(super) fn accepted(state: &mut State, id: &str, work: Option<&WorkView>) {
    if let Some(group) = state.groups.get(id)
        && group.extensions.get("setsCurrentAction") == Some(&json!(true))
    {
        state.current_action = group
            .extensions
            .get("actionKey")
            .and_then(Value::as_str)
            .map(str::to_owned);
        state.action_selected = true;
    }
    if !state.action_selected {
        state.current_action = work.and_then(fallback);
    }
    if let Some(group) = state.groups.get_mut(id)
        && group.extensions.get("planLevel") != Some(&json!(true))
    {
        if let Some(key) = &state.current_action {
            group.extensions.insert("actionKey".into(), json!(key));
        } else {
            group.extensions.remove("actionKey");
        }
    }
}

pub(super) fn bind(state: &mut State, id: &str) {
    if let Some(group) = state.groups.get_mut(id)
        && !group.published
    {
        if let Some(key) = &state.current_action {
            group.extensions.insert("actionKey".into(), json!(key));
        } else {
            group.extensions.remove("actionKey");
        }
    }
}
