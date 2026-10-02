//! Handles authorize exact registered content through the existing guarded reader.
use super::{
    GuidedTools,
    query::{self, Handle, Request},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_turn::btcc::GuidedInvocation;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const PAGE_BYTES: usize = 18_000;

#[derive(Deserialize, Serialize)]
struct Cursor {
    project: String,
    id: String,
    revision: String,
    offset: usize,
}

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    project: &str,
    request: Request,
) -> Result<Value, String> {
    if !request.name.is_empty() || !request.file_type.is_empty() || request.limit.is_some() {
        return Err("invalid_arguments".into());
    }
    let handle = request.read_handle.as_ref().ok_or("invalid_arguments")?;
    let offset = offset(project, handle, request.cursor.as_deref())?;
    let root = owner.binding.butler_data.clone();
    let project_key = project.to_owned();
    let id = handle.id.clone();
    let signal = invocation.cancellation.clone();
    let artifact = tokio::select! {
        biased;
        () = invocation.cancellation.cancelled() => return Err("cancelled".into()),
        result = tokio::task::spawn_blocking(move || query::find(&root, &project_key, &id, signal)) => {
            result.map_err(|_| "artifact_index_unavailable")??.ok_or("source_unavailable")?
        }
    };
    if artifact.revision != handle.revision {
        return Err("source_snapshot_changed".into());
    }
    let bytes = tokio::select! {
        biased;
        () = invocation.cancellation.cancelled() => return Err("cancelled".into()),
        result = owner.attachment_context.read_project_source(
            artifact.id.clone(), artifact.size, artifact.revision.clone(),
        ) => result.map_err(|error| error.code().to_owned())?,
    };
    content(project, &artifact, &bytes, offset)
}

fn content(
    project: &str,
    artifact: &query::Artifact,
    bytes: &[u8],
    offset: usize,
) -> Result<Value, String> {
    if offset > bytes.len() {
        return Err("invalid_cursor".into());
    }
    let mut end = bytes.len().min(offset.saturating_add(PAGE_BYTES));
    let text = std::str::from_utf8(bytes).ok();
    if let Some(text) = text {
        if !text.is_char_boundary(offset) {
            return Err("invalid_cursor".into());
        }
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        // JSON escaping can expand control-heavy text sixfold. Page complete
        // characters within the existing provider budget, preserving exact bytes.
        let mut encoded_bytes = 0;
        for (index, ch) in text[offset..end].char_indices() {
            encoded_bytes += match ch {
                '\"' | '\\' | '\n' | '\r' | '\t' | '\u{08}' | '\u{0c}' => 2,
                ch if ch <= '\u{1f}' => 6,
                ch => ch.len_utf8(),
            };
            if encoded_bytes > 30 * 1024 {
                end = offset + index;
                break;
            }
        }
    }
    let next = if end < bytes.len() {
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    project: project.into(),
                    id: artifact.id.clone(),
                    revision: artifact.revision.clone(),
                    offset: end,
                })
                .map_err(|_| "invalid_cursor")?,
            ),
        )
    } else {
        None
    };
    let mut result = artifact.value.clone();
    result["ok"] = json!(true);
    result["total_bytes"] = json!(bytes.len());
    result["offset_bytes"] = json!(offset);
    result["next_cursor"] = json!(next);
    result["encoding"] = json!(if text.is_some() { "utf-8" } else { "base64" });
    result["content"] = match text {
        Some(text) => json!(&text[offset..end]),
        None => json!(base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end])),
    };
    Ok(result)
}

fn offset(project: &str, handle: &Handle, raw: Option<&str>) -> Result<usize, String> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(0);
    };
    if raw.len() > 4096 {
        return Err("invalid_cursor".into());
    }
    let c: Cursor = URL_SAFE_NO_PAD
        .decode(raw)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or("invalid_cursor")?;
    if c.project != project || c.id != handle.id || c.revision != handle.revision {
        return Err("invalid_cursor".into());
    }
    Ok(c.offset)
}
