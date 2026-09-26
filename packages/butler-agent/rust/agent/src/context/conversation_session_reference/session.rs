use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;

use crate::{
    context::{apply_char_budget, to_context_message, to_context_summary},
    conversation::PublicMemorySnapshot,
    json,
};

use super::{
    ContextError, ContextResult,
    args::{self, ReadArgs},
    store_error,
};

pub(super) fn read(
    snapshot: &PublicMemorySnapshot,
    parsed: &ReadArgs,
    session_id: &str,
    input: &Value,
) -> ContextResult<Value> {
    let scope = json!({"kind":parsed.scope.kind,"project_id":if parsed.scope.kind == "current_project" { parsed.scope.current_project_id.as_deref() } else { None }});
    let Some(session) = snapshot.session(session_id).map_err(store_error)? else {
        return Ok(
            json!({"ok":false,"code":"conversation_session_not_found","conversation_session_id":session_id,"scope":scope}),
        );
    };
    if !snapshot.permits(&parsed.scope, &session.id, session.project_id.as_deref()) {
        return Ok(
            json!({"ok":false,"code":"conversation_session_scope_mismatch","conversation_session_id":"","scope":scope}),
        );
    }
    let limit = args::integer(
        input.get("limit").filter(|value| value.is_number()),
        20,
        1,
        100,
    )?;
    let max_chars = args::integer(
        input.get("max_chars").filter(|value| value.is_number()),
        8000,
        256,
        24000,
    )?;
    let direction = input
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("before");
    let direction = if ["before", "after", "around"].contains(&direction) {
        direction
    } else {
        "before"
    };
    let anchor = input
        .get("anchor_message_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty());
    if let Some(anchor) = anchor {
        let valid = snapshot
            .message(anchor)
            .map_err(store_error)?
            .is_some_and(|row| row.message.session_id == session.id);
        if !valid {
            return Err(ContextError::new(
                "invalid_scope",
                "Anchor is not part of the session",
            ));
        }
    }
    let rows = snapshot
        .context_rows(&session.id, anchor, direction, limit)
        .map_err(store_error)?;
    let rows = if parsed.scope.include_internal {
        rows
    } else {
        rows.into_iter()
            .filter(|row| {
                matches!(
                    row.message.origin_kind,
                    crate::conversation::ConversationOriginKind::UserInput
                        | crate::conversation::ConversationOriginKind::AssistantPublic
                )
            })
            .collect()
    };
    let summaries = snapshot.summaries(&session.id).map_err(store_error)?;
    let summaries = summaries
        .into_iter()
        .filter(|summary| {
            summary.covers_to_seq
                < rows
                    .first()
                    .map_or(f64::INFINITY, |row| row.message.seq as f64)
        })
        .map(|summary| to_context_summary(&summary))
        .collect::<Vec<_>>();
    let rendered = rows
        .iter()
        .map(|row| to_context_message(row, input.get("include_tools") == Some(&Value::Bool(true))))
        .collect::<Vec<_>>();
    let rendered_count = rendered.len();
    let (messages, truncated) = apply_char_budget(rendered, max_chars as f64);
    let mut result = json!({"ok":true,"session_id":session.id,"runtime_session_id":session_id,"query":null,
        "anchor_message_id":anchor,"anchor_event_id":null,"direction":direction,"returned":messages.len(),
        "truncated":truncated || rendered_count > messages.len(),"messages":messages,"summaries":summaries});
    while result["messages"]
        .as_array()
        .is_some_and(|messages| messages.len() > 1)
        && envelope_bytes(&result)? > 24 * 1024
    {
        let Some(messages) = result["messages"].as_array_mut() else {
            break;
        };
        messages.pop();
        result["returned"] = json!(messages.len());
        result["truncated"] = json!(true);
    }
    if result["messages"]
        .as_array()
        .is_some_and(|messages| messages.len() == 1)
        && envelope_bytes(&result)? > 24 * 1024
    {
        let message = &mut result["messages"][0];
        let text = message["text"].as_str().unwrap_or("");
        let truncated = UnicodeSegmentation::graphemes(text, true)
            .take(4000)
            .collect::<String>();
        message["text"] = json!(truncated);
        result["truncated"] = json!(true);
    }
    Ok(result)
}

fn envelope_bytes(value: &Value) -> ContextResult<usize> {
    let mut output = json!({"tool_name":"list_conversation_sessions"});
    for (key, value) in value.as_object().into_iter().flatten() {
        output[key] = value.clone();
    }
    json::stringify(&json!({"ok":true,"output":output}))
        .map(|text| text.len())
        .map_err(|error| ContextError::new("json", error.to_string()))
}
