//! Validated, read-only preparation for a final projection transaction.

use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use super::{TranscriptEvent, staging};
use crate::gateway::application::{
    ArtifactFileCandidate, ArtifactMaterializationRequest, storage::AppStorageError,
};
use crate::public_text::trim_js_whitespace;

pub(super) struct FinalCandidate {
    pub action_id: String,
    pub event_id: String,
    pub chat_id: String,
    pub turn_id: String,
    pub claim_id: Option<String>,
    pub reply_to_message_id: Option<String>,
    pub processed_claim_verified: bool,
    pub text: String,
    pub no_visible_reply: bool,
    pub changed_files: Vec<Value>,
    pub plan: Option<Value>,
    pub activates_plan: bool,
    pub delivery_metadata: Option<Map<String, Value>>,
    pub materialization: ArtifactMaterializationRequest,
    pub existing_message_id: Option<String>,
}

pub(super) fn candidate(
    db: &Connection,
    butler_data: &std::path::Path,
    chat_id: &str,
    event: &TranscriptEvent,
    processed_claim_verified: bool,
) -> Result<Option<FinalCandidate>, AppStorageError> {
    if event.transport.as_deref() != Some("app") || event.kind != "outbound" {
        return Ok(None);
    }
    let message = object(event.payload.get("message"));
    let metadata = object(event.payload.get("metadata"));
    if metadata.get("kind").and_then(Value::as_str) != Some("final_result") {
        return Ok(None);
    }
    let Some(action_id) = text(event.payload.get("actionId")) else {
        return Ok(None);
    };
    if staging::projected(db, &action_id)? {
        return Ok(None);
    }
    let turn_id = text(metadata.get("turnId")).or_else(|| {
        text(message.get("replyToMessageId")).and_then(|reply| db.query_row(
            "SELECT id FROM turns WHERE chat_id=?1 AND user_message_id=?2 ORDER BY rowid DESC LIMIT 1",
            params![chat_id,reply], |row| row.get(0)).optional().ok().flatten())
    });
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    let project_root: Option<String> = db.query_row(
        "SELECT p.workspace_path FROM chats c LEFT JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
        [chat_id], |row| row.get(0)).optional().map_err(AppStorageError::sqlite)?.flatten();
    let existing_message_id: Option<String> = db.query_row(
        "SELECT id FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' ORDER BY rowid DESC LIMIT 1",
        params![chat_id,turn_id], |row| row.get(0)).optional().map_err(AppStorageError::sqlite)?;
    let existing_content_keys = existing_message_id
        .as_deref()
        .map_or(Ok(Vec::new()), |id| existing_keys(db, id))?;
    let mut allowed_roots = vec![butler_data.to_path_buf()];
    if let Some(root) = project_root {
        allowed_roots.push(PathBuf::from(root));
    }
    allowed_roots.push(butler_data.join("artifacts/public-data"));
    let candidates = artifacts(message.get("artifacts"), &allowed_roots);
    let changed_files = message
        .get("changedFiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|value| {
            value.get("path").and_then(Value::as_str).is_some()
                && value.get("lines").and_then(Value::as_array).is_some()
        })
        .take(40)
        .cloned()
        .collect();
    let plan = message
        .get("plan")
        .or_else(|| metadata.get("plan"))
        .and_then(project_plan);
    let activates_plan = plan
        .as_ref()
        .is_some_and(|value| value.get("status").and_then(Value::as_str) == Some("active"))
        && turn_plan_mode(db, &turn_id)?;
    let delivery_metadata = delivery_metadata(&metadata);
    Ok(Some(FinalCandidate {
        action_id,
        event_id: event.event_id.clone(),
        chat_id: chat_id.into(),
        turn_id,
        claim_id: text(metadata.get("appQueueClaimId")),
        reply_to_message_id: text(message.get("replyToMessageId")),
        processed_claim_verified,
        text: sanitize(message.get("text")),
        no_visible_reply: metadata.get("noVisibleReply") == Some(&Value::Bool(true)),
        changed_files,
        plan,
        activates_plan,
        delivery_metadata,
        materialization: ArtifactMaterializationRequest {
            allowed_roots,
            candidates,
            existing_content_keys,
        },
        existing_message_id,
    }))
}

pub(super) fn worker_materialization(
    db: &Connection,
    butler_data: &std::path::Path,
    chat_id: &str,
    event: &TranscriptEvent,
) -> Result<Option<ArtifactMaterializationRequest>, AppStorageError> {
    let message = object(event.payload.get("message"));
    let metadata = object(event.payload.get("metadata"));
    if !matches!(
        metadata.get("kind").and_then(Value::as_str),
        Some("worker_result")
    ) && metadata.get("type").and_then(Value::as_str) != Some("worker-result")
    {
        return Ok(None);
    }
    let project_root: Option<String> = db.query_row(
        "SELECT p.workspace_path FROM chats c LEFT JOIN projects p ON p.id=c.project_id WHERE c.id=?1",
        [chat_id], |row| row.get(0)).optional().map_err(AppStorageError::sqlite)?.flatten();
    let mut roots = vec![butler_data.to_path_buf()];
    if let Some(root) = project_root {
        roots.push(PathBuf::from(root));
    }
    roots.push(butler_data.join("artifacts/public-data"));
    let candidates = artifacts(message.get("artifacts"), &roots);
    Ok(
        (!candidates.is_empty()).then(|| ArtifactMaterializationRequest {
            allowed_roots: roots,
            candidates,
            existing_content_keys: Vec::new(),
        }),
    )
}

fn delivery_metadata(metadata: &Map<String, Value>) -> Option<Map<String, Value>> {
    let state = text(
        metadata
            .get("delivery_state")
            .or_else(|| metadata.get("deliveryState")),
    )?;
    if !matches!(
        state.as_str(),
        "delivered_with_limitations"
            | "delivered_with_continuation"
            | "recovering_internal"
            | "needs_tool_surface"
            | "needs_evidence"
            | "needs_argument_repair"
    ) {
        return None;
    }
    let codes = metadata
        .get("limitation_codes")
        .or_else(|| metadata.get("limitationCodes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| text(Some(v)))
        .take(8)
        .map(Value::String)
        .collect();
    let limitations = metadata
        .get("limitations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| text(Some(v)))
        .take(8)
        .map(|v| Value::String(v.chars().take(180).collect()))
        .collect();
    Some(Map::from_iter([
        ("delivery_state".into(), state.into()),
        ("limitation_codes".into(), Value::Array(codes)),
        ("limitations".into(), Value::Array(limitations)),
    ]))
}

fn turn_plan_mode(db: &Connection, turn: &str) -> Result<bool, AppStorageError> {
    let json: String = db
        .query_row(
            "SELECT execution_controls_json FROM turns WHERE id=?1",
            [turn],
            |row| row.get(0),
        )
        .map_err(AppStorageError::sqlite)?;
    Ok(serde_json::from_str::<Value>(&json)
        .ok()
        .and_then(|v| v.get("plan_mode").and_then(Value::as_bool))
        .unwrap_or(false))
}
fn existing_keys(db: &Connection, message: &str) -> Result<Vec<String>, AppStorageError> {
    let mut statement=db.prepare("SELECT safe_name,mime_type,size_bytes,sha256 FROM message_files WHERE message_id=?1 ORDER BY rowid").map_err(AppStorageError::sqlite)?;
    statement
        .query_map([message], |row| {
            Ok(format!(
                "{}\0{}\0{}\0{}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?
            ))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
fn artifacts(value: Option<&Value>, roots: &[PathBuf]) -> Vec<ArtifactFileCandidate> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let object = item.as_object()?;
            let local = text(object.get("localPath"));
            let label = text(object.get("safePathLabel"));
            let mut paths = Vec::new();
            if let Some(path) = local {
                paths.push(PathBuf::from(path));
            }
            if let Some(label) = label.as_ref() {
                for root in roots {
                    paths.push(root.join(label));
                }
            }
            if paths.is_empty() {
                return None;
            }
            // The filesystem owner falls back to the selected path's basename.
            let name = label
                .or_else(|| text(object.get("title")))
                .unwrap_or_default();
            Some(ArtifactFileCandidate {
                candidate_paths: paths,
                name,
                mime_type: text(object.get("mimeType")),
            })
        })
        .collect()
}
fn sanitize(value: Option<&Value>) -> String {
    let text = trim_js_whitespace(value.and_then(Value::as_str).unwrap_or(""));
    if text.is_empty() {
        return String::new();
    }
    const OPEN: &str = "<butler_final_answer>";
    const CLOSE: &str = "</butler_final_answer>";
    let Some(open) = text.find(OPEN) else {
        return text.into();
    };
    let start = open + OPEN.len();
    let Some(relative) = text[start..].find(CLOSE) else {
        let rendered = text.replace(OPEN, "").replace(CLOSE, "");
        return trim_js_whitespace(&rendered).into();
    };
    let close = start + relative;
    let before = trim_js_whitespace(&text[..open]);
    let body = trim_js_whitespace(&text[start..close]);
    let after = trim_js_whitespace(&text[close + CLOSE.len()..]);
    if !before.is_empty() {
        return if body.is_empty() { after } else { body }.into();
    }
    [body, after]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}
fn project_plan(value: &Value) -> Option<Value> {
    let plan = value.as_object()?;
    if plan.get("kind").and_then(Value::as_str) != Some("plan") {
        return None;
    }
    let id = text(plan.get("id"))?;
    let title = text(plan.get("title"))?;
    let status = text(plan.get("status"))?;
    let body = plan.get("body").and_then(Value::as_str)?;
    if trim_js_whitespace(body).is_empty() {
        return None;
    }
    let mut projected = Map::new();
    projected.insert("kind".into(), "plan".into());
    projected.insert("id".into(), id.into());
    projected.insert("title".into(), title.into());
    projected.insert("status".into(), status.into());
    projected.insert("body".into(), body.into());
    if let Some(path) = text(plan.get("path")) {
        projected.insert("path".into(), path.into());
    }
    Some(Value::Object(projected))
}
fn object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}
fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}
