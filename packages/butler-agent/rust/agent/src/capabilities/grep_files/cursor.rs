use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};

use crate::workspace::cursor_path;

#[derive(Clone)]
pub(super) struct GrepCursor {
    pub query: String,
    pub scan_path: String,
    pub inclusive: bool,
    pub marker: Option<String>,
    pub line: Option<usize>,
    pub window_start: Option<String>,
    pub window_end: Option<String>,
}

pub(super) fn decode(value: &Value) -> Option<GrepCursor> {
    let raw = value.as_str()?;
    if raw.is_empty() || raw.encode_utf16().count() > 4096 {
        return None;
    }
    let bytes = super::super::cursor::decode_buffer_base64url(raw);
    let decoded: Value = serde_json::from_slice(&bytes).ok()?;
    let fields = decoded.as_object()?;
    if fields.get("v")?.as_f64()? != 1.0 || fields.get("tool")?.as_str()? != "grep_files" {
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
    let scan_path = cursor_path(fields.get("scan_path")?.as_str()?)?.to_owned();
    let inclusive = fields.get("scan_inclusive")?.as_bool()?;
    if ["request_index", "offset_bytes", "file_path", "file_sha256"]
        .iter()
        .any(|key| fields.contains_key(*key))
    {
        return None;
    }
    let optional_path = |key| -> Option<Option<String>> {
        match fields.get(key) {
            None => Some(None),
            Some(value) => Some(Some(cursor_path(value.as_str()?)?.to_owned())),
        }
    };
    let marker = optional_path("marker")?;
    let line = match fields.get("line") {
        None => Some(None),
        Some(value) => Some(Some({
            let number = value.as_f64()?;
            if !number.is_finite() || number < 1.0 || number.fract() != 0.0 {
                return None;
            }
            crate::json::saturating_usize(number)
        })),
    }?;
    let window_start = optional_path("window_start_path")?;
    let window_end = optional_path("window_end_path")?;
    if inclusive {
        let (Some(marker), Some(_line), Some(start), Some(end)) =
            (&marker, line, &window_start, &window_end)
        else {
            return None;
        };
        let compare = |left: &str, right: &str| left.encode_utf16().cmp(right.encode_utf16());
        if scan_path != *start
            || compare(start, end).is_gt()
            || compare(marker, start).is_lt()
            || compare(marker, end).is_gt()
        {
            return None;
        }
    } else if marker.is_some() || line.is_some() || window_start.is_some() || window_end.is_some() {
        return None;
    }
    Some(GrepCursor {
        query: query.into(),
        scan_path,
        inclusive,
        marker,
        line,
        window_start,
        window_end,
    })
}

pub(super) fn encode(cursor: &GrepCursor) -> String {
    let mut fields = Map::new();
    fields.insert("v".into(), json!(1));
    fields.insert("tool".into(), json!("grep_files"));
    fields.insert("query".into(), json!(cursor.query));
    fields.insert("scan_path".into(), json!(cursor.scan_path));
    fields.insert("scan_inclusive".into(), json!(cursor.inclusive));
    if let Some(marker) = &cursor.marker {
        fields.insert("marker".into(), json!(marker));
    }
    if let Some(line) = cursor.line {
        fields.insert("line".into(), json!(line));
    }
    if let Some(start) = &cursor.window_start {
        fields.insert("window_start_path".into(), json!(start));
    }
    if let Some(end) = &cursor.window_end {
        fields.insert("window_end_path".into(), json!(end));
    }
    URL_SAFE_NO_PAD.encode(Value::Object(fields).to_string())
}
