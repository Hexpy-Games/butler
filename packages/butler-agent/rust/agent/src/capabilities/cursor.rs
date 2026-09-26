use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::workspace::cursor_path;

#[derive(Clone, Debug)]
pub(super) struct ReadCursor {
    pub query: String,
    pub request_index: usize,
    pub offset_bytes: usize,
    pub file_sha256: String,
}

pub(super) fn query_hash(value: &Value) -> Result<String, crate::json::JsonError> {
    let sorted = sort_keys(value);
    let mut encoded = String::new();
    crate::json::append_json(&sorted, &mut encoded)?;
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}
fn sort_keys(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            let mut sorted = Map::new();
            for (key, value) in entries {
                sorted.insert(key.clone(), sort_keys(value));
            }
            Value::Object(sorted)
        }
        _ => value.clone(),
    }
}

pub(super) fn encode(query: &str, index: usize, offset: usize, path: &str, sha: &str) -> String {
    let mut object = Map::new();
    object.insert("v".into(), json!(1));
    object.insert("tool".into(), json!("read_file"));
    object.insert("query".into(), json!(query));
    object.insert("request_index".into(), json!(index));
    object.insert("offset_bytes".into(), json!(offset));
    if cursor_path(path).is_some() {
        object.insert("file_path".into(), json!(path));
    }
    object.insert("file_sha256".into(), json!(sha));
    URL_SAFE_NO_PAD.encode(Value::Object(object).to_string())
}

pub(super) fn decode(value: &Value) -> Option<ReadCursor> {
    let raw = value.as_str()?;
    if raw.is_empty() || raw.encode_utf16().count() > 4096 {
        return None;
    }
    // Buffer.from(base64url) ignores junk, stops at padding, and discards
    // incomplete low-order bits rather than requiring canonical encoding.
    let bytes = decode_buffer_base64url(raw);
    let record: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let object = record.as_object()?;
    if object.get("v")?.as_f64()? != 1.0 || object.get("tool")?.as_str()? != "read_file" {
        return None;
    }
    let query = object.get("query")?.as_str()?;
    if query.len() != 64
        || !query
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    if object.contains_key("marker")
        || object.contains_key("scan_path")
        || object.contains_key("scan_inclusive")
        || object.contains_key("window_start_path")
        || object.contains_key("window_end_path")
        || object.contains_key("line")
    {
        return None;
    }
    if let Some(path) = object.get("file_path") {
        cursor_path(path.as_str()?)?;
    }
    let sha = object.get("file_sha256")?.as_str()?;
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    Some(ReadCursor {
        query: query.to_owned(),
        request_index: nonnegative_integer(object.get("request_index")?)?,
        offset_bytes: nonnegative_integer(object.get("offset_bytes")?)?,
        file_sha256: sha.to_owned(),
    })
}

pub(super) fn decode_buffer_base64url(raw: &str) -> Vec<u8> {
    let mut decoded = Vec::with_capacity(raw.len() * 3 / 4);
    let mut bits = 0u32;
    let mut count = 0u8;
    for byte in raw.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            decoded.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    decoded
}

fn nonnegative_integer(value: &Value) -> Option<usize> {
    let number = value.as_f64()?;
    (number.is_finite() && number >= 0.0 && number.fract() == 0.0).then_some(number as usize)
}
