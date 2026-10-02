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
    let scope = match args.get("scope").and_then(Value::as_str) {
        Some("global") => "global".to_owned(),
        Some("session") => format!("session:{}", owner.binding.memory.runtime_session_id),
        Some("project") => match &owner.binding.memory.project_id {
            Some(project) => format!("project:{project}"),
            None => return failure("feedback_project_unbound", "Use a project chat."),
        },
        _ => {
            return failure(
                "feedback_scope_invalid",
                "Choose global, project or session.",
            );
        }
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
    let represented_by = represented(owner, &scope, text).await;
    let input = FeedbackCapture {
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
