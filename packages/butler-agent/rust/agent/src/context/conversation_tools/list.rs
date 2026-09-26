mod args;
mod catalog;

use serde_json::{Value, json};
use std::path::Path;
use unicode_segmentation::UnicodeSegmentation;

use super::{ContextError, ContextResult};
use crate::{
    conversation::{CanonicalMemoryReadBinding, PublicMemorySnapshot, decode_message_scalars},
    json,
};
use args::{ListCursor, encode_cursor};

pub(super) fn run(
    path: &Path,
    data_root: &Path,
    binding: &CanonicalMemoryReadBinding,
    input: &Value,
) -> ContextResult<Value> {
    let snapshot = match PublicMemorySnapshot::open(path, binding) {
        Ok(snapshot) => snapshot,
        Err(error) if error.code == "invalid_scope" => return Ok(failure("invalid_scope", &[])),
        Err(_) => {
            return Ok(failure(
                "backend_unavailable",
                &["conversation_store_unavailable"],
            ));
        }
    };
    let parsed = match args::parse(
        input,
        &snapshot.current_session_id,
        binding
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    ) {
        Ok(parsed) => parsed,
        Err(code) => return Ok(failure("invalid_arguments", &[code])),
    };
    let result = read(&snapshot, data_root, &parsed);
    match result {
        Ok(result) => Ok(result),
        Err(error) if error.code == "stale_cursor" => Ok(failure("stale_cursor", &[])),
        Err(error) if error.code == "invalid_scope" => Ok(failure("invalid_scope", &[])),
        Err(_) => Ok(failure(
            "backend_unavailable",
            &["conversation_store_unavailable"],
        )),
    }
}

fn read(
    snapshot: &PublicMemorySnapshot,
    data_root: &Path,
    parsed: &args::ListArgs,
) -> ContextResult<Value> {
    if !snapshot
        .validate_scope(&parsed.scope)
        .map_err(store_error)?
    {
        return Err(ContextError::new(
            "invalid_scope",
            "Invalid canonical scope",
        ));
    }
    let revision = snapshot.revision().map_err(store_error)?;
    if parsed.cursor.as_ref().is_some_and(|cursor| {
        cursor.revision != revision || cursor.filter_hash != parsed.filter_hash
    }) {
        return Err(ContextError::new(
            "stale_cursor",
            "Conversation source changed",
        ));
    }
    let time = parsed
        .time
        .as_ref()
        .map(|(from, to)| (from.as_str(), to.as_str()));
    let after = parsed
        .cursor
        .as_ref()
        .map(|cursor| (cursor.last_at.as_str(), cursor.session_id.as_str()));
    let rows = snapshot
        .session_page(&parsed.scope, parsed.include_archived, time, after, 1001)
        .map_err(store_error)?;
    let ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let (labels, diagnostics) = catalog::read(data_root, &ids);
    let selected = rows
        .iter()
        .filter(|row| {
            parsed.session_kind == "any"
                || labels
                    .get(&row.id)
                    .map_or(parsed.session_kind == "unknown", |label| {
                        label.kind == parsed.session_kind
                    })
        })
        .take(parsed.limit + 1)
        .collect::<Vec<_>>();
    let scan_continues = rows.len() == 1001;
    let mut has_more = selected.len() > parsed.limit || scan_continues;
    let mut sessions = Vec::with_capacity(parsed.limit);
    for row in selected.iter().take(parsed.limit) {
        let previews = snapshot
            .preview_messages(
                &row.id,
                parsed.scope.include_internal,
                time,
                parsed.preview_messages,
            )
            .map_err(store_error)?;
        let previews = previews
            .iter()
            .map(|message| {
                let text = decode_message_scalars(message)
                    .first()
                    .map(|scalar| scalar.text)
                    .unwrap_or("");
                json!({"conversation_message_id":message.message.id,"role":message.message.role,
                "created_at":message.message.created_at,"text":truncate(text,900)})
            })
            .collect::<Vec<_>>();
        let binding = snapshot
            .external_session_id(&row.id, &row.gateway_origin)
            .map_err(store_error)?;
        let label = labels.get(&row.id);
        sessions.push(json!({"conversation_session_id":row.id,"external_session_id":binding,
            "title":label.and_then(|label|label.title.as_deref()).filter(|title|!title.is_empty()).map(|title|truncate(title,512)),
            "catalog_source":label.map(|_|"app-catalog-compat"),"session_kind":label.map_or("unknown",|label|label.kind.as_str()),
            "workspace_id":row.workspace_id,"project_id":row.project_id,"gateway_origin":row.gateway_origin,
            "status":row.status,"archived":row.status=="archived","created_at":row.created_at,
            "updated_at":row.updated_at,"last_eligible_message_at":row.last_eligible_message_at,
            "message_count":row.message_count,"recent_messages":previews}));
    }
    let scope = json!({"kind":parsed.scope.kind,"project_id":if parsed.scope.kind=="current_project" {parsed.scope.current_project_id.as_deref()}else{None}});
    let mut result = json!({"ok":true,"status":if has_more{"partial"}else{"complete"},"scope":scope,
        "current_conversation_session_id":snapshot.current_session_id,"returned":sessions.len(),
        "sessions":sessions,"next_cursor":null,"diagnostics":diagnostics});
    set_cursor(&mut result, parsed, revision, &rows, &selected, has_more);
    while result["sessions"]
        .as_array()
        .is_some_and(|sessions| sessions.len() > 1)
        && envelope_bytes(&result)? > 24 * 1024
    {
        let Some(sessions) = result["sessions"].as_array_mut() else {
            break;
        };
        sessions.pop();
        let returned = sessions.len();
        has_more = true;
        result["returned"] = json!(returned);
        result["status"] = json!("partial");
        add_diagnostic(&mut result, "serialization_budget");
        set_cursor(&mut result, parsed, revision, &rows, &selected, has_more);
    }
    if result["sessions"]
        .as_array()
        .is_some_and(|sessions| sessions.len() == 1)
        && envelope_bytes(&result)? > 24 * 1024
    {
        result["status"] = json!("partial");
        add_diagnostic(&mut result, "serialization_budget");
        add_diagnostic(&mut result, "preview_truncated");
        while result["sessions"][0]["recent_messages"]
            .as_array()
            .is_some_and(|items| items.len() > 1)
            && envelope_bytes(&result)? > 24 * 1024
        {
            let Some(preview) = result["sessions"][0]["recent_messages"].as_array_mut() else {
                break;
            };
            preview.remove(0);
        }
        while result["sessions"][0]["recent_messages"]
            .as_array()
            .is_some_and(|items| items.len() == 1)
            && envelope_bytes(&result)? > 24 * 1024
        {
            let text = result["sessions"][0]["recent_messages"][0]["text"]
                .as_str()
                .unwrap_or("");
            let length = UnicodeSegmentation::graphemes(text, true).count();
            if length <= 1 {
                break;
            }
            result["sessions"][0]["recent_messages"][0]["text"] =
                json!(truncate(text, (length * 3 / 4).max(1)));
        }
        if envelope_bytes(&result)? > 24 * 1024
            && let Some(preview) = result["sessions"][0]["recent_messages"].as_array_mut()
        {
            preview.clear();
        }
        set_cursor(&mut result, parsed, revision, &rows, &selected, has_more);
    }
    if scan_continues {
        add_diagnostic(&mut result, "scan_continues");
    }
    Ok(result)
}

fn set_cursor(
    result: &mut Value,
    parsed: &args::ListArgs,
    revision: u64,
    rows: &[crate::conversation::PublicSessionRow],
    selected: &[&crate::conversation::PublicSessionRow],
    has_more: bool,
) {
    let budget = result["diagnostics"]
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v == "serialization_budget"));
    let tail = if selected.len() > parsed.limit || budget {
        result["sessions"]
            .as_array()
            .and_then(|items| items.last())
            .map(|value| {
                (
                    value["last_eligible_message_at"].as_str(),
                    value["conversation_session_id"].as_str(),
                )
            })
    } else {
        rows.last().map(|row| {
            (
                Some(row.last_eligible_message_at.as_str()),
                Some(row.id.as_str()),
            )
        })
    };
    result["next_cursor"] = tail
        .and_then(|(at, id)| Some((at?, id?)))
        .filter(|_| has_more)
        .map_or(Value::Null, |(at, id)| {
            json!(encode_cursor(&ListCursor {
                schema: "butler.list-conversation-sessions-cursor.v2".into(),
                filter_hash: parsed.filter_hash.clone(),
                revision,
                last_at: at.into(),
                session_id: id.into()
            }))
        });
}
fn envelope_bytes(value: &Value) -> ContextResult<usize> {
    let mut output = json!({"tool_name":"list_conversation_sessions"});
    for (key, item) in value.as_object().into_iter().flatten() {
        output[key] = item.clone();
    }
    json::stringify(&json!({"ok":true,"output":output}))
        .map(|text| text.len())
        .map_err(|error| ContextError::new("json", error.to_string()))
}
fn add_diagnostic(value: &mut Value, text: &str) {
    let Some(items) = value["diagnostics"].as_array_mut() else {
        return;
    };
    if !items.iter().any(|item| item == text) {
        items.push(json!(text));
    }
}
fn truncate(text: &str, max: usize) -> String {
    UnicodeSegmentation::graphemes(text, true)
        .take(max)
        .collect()
}
fn failure(code: &str, diagnostics: &[&str]) -> Value {
    json!({"ok":false,"code":code,"diagnostics":diagnostics})
}
fn store_error(error: crate::conversation::ConversationError) -> ContextError {
    ContextError::new("conversation_store_unavailable", error.to_string())
}
