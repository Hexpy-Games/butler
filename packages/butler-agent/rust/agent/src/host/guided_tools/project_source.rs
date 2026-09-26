//! Current-Turn App project source snapshots, never live project files.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Map, Value, json};

use crate::btcc::{BtccError, ModelRoundToolCall, ToolExecutionError};
use crate::json::JsonDocument;

use super::NativeGuidedTools;

const PAGE_UTF16: usize = 24_000;

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let args = &call.arguments;
    let Some(file_id) = args.get("file_id").and_then(Value::as_str) else {
        return encoded(&json!({"ok":false,"error":"source_unavailable"}));
    };
    if !valid_file_id(file_id) {
        return encoded(&json!({"ok":false,"error":"source_unavailable"}));
    }
    let Some(source) = owner.binding.project_sources.iter().find(|source| {
        source
            .pointer("/originalRef/fileId")
            .and_then(Value::as_str)
            == Some(file_id)
    }) else {
        return encoded(&json!({"ok":false,"error":"source_not_admitted"}));
    };
    let Some(digest) = source
        .pointer("/originalRef/sha256")
        .and_then(Value::as_str)
    else {
        return encoded(&json!({"ok":false,"error":"source_unavailable"}));
    };
    let Some(size) = source
        .pointer("/originalRef/sizeBytes")
        .and_then(Value::as_u64)
    else {
        return encoded(&json!({"ok":false,"error":"source_unavailable"}));
    };
    let offset = match parse_cursor(args, file_id, digest) {
        Ok(offset) => offset,
        Err(()) => return encoded(&invalid_cursor()),
    };
    let bytes = match owner
        .attachment_context
        .read_project_source(file_id.to_owned(), size, digest.to_owned())
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let code = if error.code == "source_snapshot_changed" {
                "source_snapshot_changed"
            } else {
                "source_unavailable"
            };
            return encoded(&json!({"ok":false,"error":code}));
        }
    };
    let body = match String::from_utf8(bytes) {
        Ok(body) => body,
        Err(_) => return encoded(&json!({"ok":false,"error":"source_unavailable"})),
    };
    let units: Vec<u16> = body.encode_utf16().collect();
    if offset > units.len() {
        return encoded(&invalid_cursor());
    }
    let mut end = units.len().min(offset.saturating_add(PAGE_UTF16));
    if end < units.len() && end > offset && (0xd800..=0xdbff).contains(&units[end - 1]) {
        end -= 1;
    }
    let content = match String::from_utf16(&units[offset..end]) {
        Ok(content) => content,
        Err(_) => return encoded(&invalid_cursor()),
    };
    let truncated = end < units.len();
    let next_cursor = truncated.then(|| {
        URL_SAFE_NO_PAD.encode(json!({"fileId":file_id,"digest":digest,"offset":end}).to_string())
    });
    encoded(&json!({
        "ok":true,"title":source.get("title").cloned().unwrap_or(Value::Null),
        "source":source.get("source").cloned().unwrap_or(Value::Null),
        "content":content,"truncated":truncated,"next_cursor":next_cursor,
    }))
}

fn parse_cursor(args: &Map<String, Value>, file_id: &str, digest: &str) -> Result<usize, ()> {
    match args.get("cursor") {
        None => Ok(0),
        Some(Value::String(cursor)) if cursor.is_empty() => Ok(0),
        Some(Value::String(cursor)) if cursor.len() <= 1024 => {
            let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| ())?;
            let cursor: Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
            if cursor.get("fileId").and_then(Value::as_str) != Some(file_id)
                || cursor.get("digest").and_then(Value::as_str) != Some(digest)
            {
                return Err(());
            }
            cursor
                .get("offset")
                .and_then(Value::as_u64)
                .filter(|offset| *offset <= 9_007_199_254_740_991)
                .and_then(|offset| usize::try_from(offset).ok())
                .ok_or(())
        }
        _ => Err(()),
    }
}

fn valid_file_id(value: &str) -> bool {
    value.strip_prefix("file-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn invalid_cursor() -> Value {
    json!({"ok":false,"error":"invalid_cursor","recovery_hint":
        "For the first page omit cursor or use an empty string. For later pages copy next_cursor exactly; do not guess it."})
}

fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_project_source_result_json",
            error.to_string(),
        ))
    })
}
