//! Source phase-scoped memory projection over immutable Context Documents.

use std::collections::HashMap;

use serde_json::Value;

use crate::btcc::{BtccError, BtccRepositories, ContextDocumentRead, TurnRecord};

fn error(code: &'static str) -> BtccError {
    BtccError::relayed(code, code)
}

fn refs<'a>(turn: &'a TurnRecord, field: &str) -> impl Iterator<Item = &'a str> {
    turn.context
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn priority(document: &ContextDocumentRead) -> u8 {
    if document.projection_class != "mandatory_hot_cache" {
        return 0;
    }
    match document.source_id.as_str() {
        "runtime-state" => 2,
        "rules" => 1,
        _ => 0,
    }
}

pub(super) async fn read(
    repo: &BtccRepositories,
    turn: &TurnRecord,
    phase: &str,
) -> Result<Vec<ContextDocumentRead>, BtccError> {
    let mut documents = Vec::new();
    for (field, class) in [
        ("profileRefs", "profile"),
        ("recentFeedbackRefs", "recent_feedback"),
        ("mandatoryHotCacheRefs", "mandatory_hot_cache"),
        ("optionalHotCacheRefs", "optional_hot_cache"),
    ] {
        for reference in refs(turn, field) {
            let document = repo
                .read_context_document(reference.to_owned())
                .await
                .map_err(|_| error("phase_scoped_memory_document_invalid"))?;
            if document.context_ref != reference || document.projection_class != class {
                return Err(error("phase_scoped_memory_document_invalid"));
            }
            let allowed = class == "profile"
                || class == "recent_feedback"
                || (class == "mandatory_hot_cache" && phase != "direct")
                || (class == "optional_hot_cache" && phase == "execution");
            if allowed || priority(&document) > 0 {
                documents.push(document);
            }
        }
    }
    documents.sort_by_key(|document| std::cmp::Reverse(priority(document)));
    Ok(documents)
}

fn write_string(value: &str, output: &mut String) -> Result<(), BtccError> {
    crate::json::write_string(value, output)
        .map_err(|_| error("phase_scoped_memory_document_invalid"))
}

fn encoded(document: &ContextDocumentRead, content: &str) -> Result<String, BtccError> {
    let mut output = String::new();
    output.push_str("{\"sourceId\":");
    write_string(&document.source_id, &mut output)?;
    output.push_str(",\"projectionClass\":");
    write_string(&document.projection_class, &mut output)?;
    output.push_str(",\"scopeKind\":");
    write_string(&document.scope_kind, &mut output)?;
    output.push_str(",\"sourceRevision\":");
    write_string(&document.source_revision, &mut output)?;
    output.push_str(",\"content\":");
    write_string(content, &mut output)?;
    output.push('}');
    Ok(output)
}

fn prefix_content(value: &str, max_bytes: usize) -> Result<&str, BtccError> {
    if max_bytes == 0 {
        return Ok("");
    }
    let mut bytes = 0;
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let mut encoded = String::new();
        write_string(&character.to_string(), &mut encoded)?;
        let size = encoded.len() - 2;
        if bytes + size > max_bytes {
            break;
        }
        bytes += size;
        end = index + character.len_utf8();
    }
    Ok(&value[..end])
}

pub(super) fn render(
    documents: &[ContextDocumentRead],
    budget: usize,
) -> Result<HashMap<String, String>, BtccError> {
    let mut remaining = budget;
    let mut rendered = HashMap::with_capacity(documents.len());
    for document in documents {
        let content = prefix_content(&document.content, remaining)?;
        let empty_size = encoded(document, "")?.len();
        let projected = encoded(document, content)?;
        remaining = remaining.saturating_sub(projected.len().saturating_sub(empty_size));
        rendered.insert(document.context_ref.clone(), projected);
    }
    Ok(rendered)
}
