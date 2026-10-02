//! Recent feedback uses canonical authored provenance and runtime scope.
use super::{
    super::GuidedTools, binding_failure, canonical_authored_source, cognition_failure, failure,
};
use butler_memory::cognition::FeedbackCapture;
use butler_turn::btcc::GuidedInvocation;
use serde_json::{Map, Value};

pub(super) async fn record(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    args: &Map<String, Value>,
    call_id: &str,
) -> Value {
    let (session, message) = match canonical_authored_source(owner, invocation).await {
        Ok((Some(session), Some(message))) => (session, message),
        Ok(_) => return binding_failure("invalid_scope"),
        Err(code) => return binding_failure(code),
    };
    let scope = match bound_scope(owner, args) {
        Ok(scope) => scope,
        Err(error) => return error,
    };
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if text.is_empty() {
        return failure("feedback_text_required", "Feedback text is required.");
    }
    let category = args
        .get("category")
        .and_then(Value::as_str)
        .unwrap_or("unrouted");
    let target = args
        .get("target_ref")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let retention = if category == "session_only" {
        "session_only"
    } else {
        args.get("retention_class")
            .and_then(Value::as_str)
            .unwrap_or("ephemeral")
    };
    let scope = if retention == "session_only" {
        format!("session:{}", owner.binding.memory.runtime_session_id)
    } else {
        scope
    };
    let represented_by = represented(owner, &scope, text).await;
    let instruction_target = match selected_instruction(invocation, target, &scope) {
        Ok(target) => target,
        Err(error) => return error,
    };
    let input = FeedbackCapture {
        instruction_target,
        represented_by,
        operation_id: format!("{}:{call_id}", invocation.turn.turn_id),
        text: text.into(),
        scope,
        category: category.into(),
        target_ref: target.into(),
        retention_class: retention.into(),
        session_id: session,
        message_id: message,
        turn_id: invocation.turn.turn_id.clone(),
        needs_clarification: args
            .get("needs_clarification")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || category == "unrouted"
            || (target == "unknown" && matches!(category, "source_policy" | "tool_policy")),
    };
    match owner.memory_writes.feedback.capture(input).await {
        Ok(result) => result,
        Err(error) => cognition_failure(error.code(), &error.message()),
    }
}

async fn represented(owner: &GuidedTools, scope: &str, text: &str) -> Option<String> {
    let project = scope.strip_prefix("project:");
    if scope != "global" && project.is_none() {
        return None;
    }
    owner
        .memory_writes
        .rules
        .list()
        .await
        .ok()?
        .into_iter()
        .find(|entry| entry.text.trim() == text && entry.project_id.as_deref() == project)
        .map(|entry| entry.handle)
}

fn selected_instruction(
    invocation: GuidedInvocation<'_>,
    target: &str,
    scope: &str,
) -> Result<Option<butler_memory::cognition::RememberedRuleTarget>, Value> {
    if !target.starts_with('R') || !target[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let row = invocation
        .turn
        .context
        .get("rememberedRuleSnapshot")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|row| row["handle"].as_str() == Some(target))
        .ok_or_else(|| {
            failure(
                "feedback_target_unavailable",
                "Choose a visible Instructions handle.",
            )
        })?;
    let selected: butler_memory::cognition::RememberedRuleTarget =
        serde_json::from_value(row.clone()).map_err(|_| {
            failure(
                "feedback_target_unavailable",
                "Choose a visible Instructions handle.",
            )
        })?;
    if selected.project_id.as_deref() != scope.strip_prefix("project:")
        || (scope != "global" && !scope.starts_with("project:"))
    {
        return Err(failure(
            "feedback_scope_mismatch",
            "Use the Instructions scope.",
        ));
    }
    Ok(Some(selected))
}

fn bound_scope(owner: &GuidedTools, args: &Map<String, Value>) -> Result<String, Value> {
    match args.get("scope").and_then(Value::as_str) {
        Some("global") => Ok("global".to_owned()),
        Some("session") => Ok(format!(
            "session:{}",
            owner.binding.memory.runtime_session_id
        )),
        Some("project") => owner
            .binding
            .memory
            .project_id
            .as_ref()
            .map(|project| format!("project:{project}"))
            .ok_or_else(|| failure("feedback_project_unbound", "Use a project chat.")),
        _ => Err(failure(
            "feedback_scope_invalid",
            "Choose global, project or session.",
        )),
    }
}
