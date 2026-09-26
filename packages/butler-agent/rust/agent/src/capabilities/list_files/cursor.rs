use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};

use crate::workspace::cursor_path;

pub(super) struct ListCursor {
    pub query: String,
    pub marker: String,
}

pub(super) fn encode(query: &str, marker: &str) -> String {
    let mut fields = Map::new();
    fields.insert("v".into(), json!(1));
    fields.insert("tool".into(), json!("list_files"));
    fields.insert("query".into(), json!(query));
    fields.insert("marker".into(), json!(marker));
    URL_SAFE_NO_PAD.encode(Value::Object(fields).to_string())
}

pub(super) fn decode(value: &Value) -> Option<ListCursor> {
    let raw = value.as_str()?;
    if raw.is_empty() || raw.encode_utf16().count() > 4_096 {
        return None;
    }
    let bytes = super::super::cursor::decode_buffer_base64url(raw);
    let decoded: Value = serde_json::from_slice(&bytes).ok()?;
    let fields = decoded.as_object()?;
    if fields.get("v")?.as_f64()? != 1.0 || fields.get("tool")?.as_str()? != "list_files" {
        return None;
    }
    let query = fields.get("query")?.as_str()?;
    if query.len() != 64
        || !query
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return None;
    }
    let marker = fields.get("marker")?.as_str()?;
    cursor_path(marker)?;
    if [
        "scan_path",
        "scan_inclusive",
        "window_start_path",
        "window_end_path",
        "line",
        "request_index",
        "offset_bytes",
        "file_path",
        "file_sha256",
    ]
    .iter()
    .any(|key| fields.contains_key(*key))
    {
        return None;
    }
    Some(ListCursor {
        query: query.into(),
        marker: marker.into(),
    })
}
