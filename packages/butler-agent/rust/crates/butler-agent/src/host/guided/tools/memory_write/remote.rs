use super::*;
use butler_turn::remote_instructions::{self, PendingInstruction, PendingTarget};

pub(super) async fn remote_queue(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    args: &Map<String, Value>,
    _call_id: &str,
    action: &str,
) -> Value {
    let (action, text, handle) = if action == "forget" {
        if let Err(error) = require_source(args) {
            return error;
        }
        let rule = args.get("rule").unwrap_or(&Value::Null);
        ("forget", None, Some(rule))
    } else {
        let text = match remember_text(args) {
            Ok(text) if text.len() <= 8192 => text.to_owned(),
            Ok(_) => {
                return failure(
                    "update_explicit_memory_text_too_long",
                    "Instruction text is too long.",
                );
            }
            Err(error) => return error,
        };
        match args.get("replaces") {
            Some(handle) => ("replace", Some(text), Some(handle)),
            None => ("remember", Some(text), None),
        }
    };
    let target = match handle
        .map(|h| pending_target(owner, invocation, h))
        .transpose()
    {
        Ok(target) => target,
        Err(error) => return error,
    };
    let duration = args
        .get("duration")
        .and_then(Value::as_str)
        .unwrap_or("always");
    if !matches!(duration, "always" | "7 days" | "this chat") {
        return failure(
            "instruction_duration_invalid",
            "Use always, 7 days or this chat.",
        );
    }
    let now = chrono::Utc::now();
    let expires_at = match duration {
        "this chat" => Some((now + chrono::Duration::hours(24)).to_rfc3339()),
        "7 days" => Some((now + chrono::Duration::days(7)).to_rfc3339()),
        _ => None,
    };
    let local = duration == "this chat";
    let item = PendingInstruction {
        id: uuid::Uuid::new_v4().to_string(),
        action: action.to_owned(),
        text,
        target,
        duration: duration.into(),
        expires_at,
        session_id: owner.binding.memory.runtime_session_id.clone(),
        saved_at: now.to_rfc3339(),
        local,
        delivered: false,
    };
    if remote_instructions::queue(&owner.binding.butler_data, item)
        .await
        .is_err()
    {
        return binding_failure("backend_unavailable");
    }
    let message = if local {
        "Saved for this chat."
    } else {
        "Saved on this computer. It applies everywhere after you confirm it on the main device."
    };
    json!({"ok":true,"output":{"status":"awaiting_confirmation","message":message}})
}

fn pending_target(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    handle: &Value,
) -> Result<PendingTarget, Value> {
    let (row, text) = selected_target(owner, invocation, handle)?;
    Ok(PendingTarget {
        handle: row.handle,
        revision: row.expected_revision,
        text: text
            .ok_or_else(|| failure("rule_snapshot_invalid", "Rule snapshot is unavailable."))?,
    })
}
