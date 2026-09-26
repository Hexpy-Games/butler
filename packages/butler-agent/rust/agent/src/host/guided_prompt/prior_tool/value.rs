//! Source argument bounds and fallback digests. No result body is parsed here.

use serde_json::{Map, Value};

use crate::btcc::BtccError;

use super::{digest, encode};

const MAX_STRING_UNITS: usize = 480;
const MAX_ITEMS: usize = 20;
const MAX_KEYS: usize = 40;
const MAX_DEPTH: usize = 6;

pub(super) fn project(value: Value, depth: usize, key: &str) -> Result<Value, BtccError> {
    // An oversized container keeps a digest of its full encoding.
    let oversized = depth < MAX_DEPTH
        && match &value {
            Value::Array(items) => items.len() > MAX_ITEMS,
            Value::Object(object) => object.len() > MAX_KEYS,
            _ => false,
        };
    let encoded = if oversized {
        Some(encode(&value)?)
    } else {
        None
    };
    match value {
        Value::String(text) => {
            let chars = text.encode_utf16().count();
            if key == "path" || chars <= MAX_STRING_UNITS {
                Ok(Value::String(text))
            } else {
                let mut compact = Map::new();
                compact.insert("chars".into(), chars.into());
                compact.insert("sha256".into(), digest(&text).into());
                Ok(Value::Object(compact))
            }
        }
        Value::Array(items) if depth < MAX_DEPTH => {
            let count = items.len();
            if let Some(encoded) = encoded {
                let selected = items
                    .into_iter()
                    .take(MAX_ITEMS)
                    .map(|item| project(item, depth + 1, ""))
                    .collect::<Result<Vec<_>, _>>()?;
                let mut compact = Map::new();
                compact.insert("items".into(), Value::Array(selected));
                compact.insert("total_items".into(), count.into());
                compact.insert("sha256".into(), digest(&encoded).into());
                Ok(Value::Object(compact))
            } else {
                Ok(Value::Array(
                    items
                        .into_iter()
                        .map(|item| project(item, depth + 1, ""))
                        .collect::<Result<_, _>>()?,
                ))
            }
        }
        Value::Object(object) if depth < MAX_DEPTH => {
            let count = object.len();
            let mut entries = object.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
            let mut projected = Map::new();
            for (key, child) in entries.into_iter().take(MAX_KEYS) {
                projected.insert(key.clone(), project(child, depth + 1, &key)?);
            }
            if let Some(original) = encoded {
                projected.insert("omitted_keys".into(), (count - MAX_KEYS).into());
                projected.insert("sha256".into(), digest(&original).into());
            }
            Ok(Value::Object(projected))
        }
        Value::Array(items) => Ok(digest_value(&Value::Array(items))?),
        Value::Object(object) => Ok(digest_value(&Value::Object(object))?),
        other => Ok(other),
    }
}

fn digest_value(value: &Value) -> Result<Value, BtccError> {
    let encoded = encode(value)?;
    Ok(serde_json::json!({"bytes":encoded.len(),"sha256":digest(&encoded)}))
}

pub(super) fn json_digest(encoded: &str) -> String {
    format!(
        "{{\"bytes\":{},\"sha256\":\"{}\"}}",
        encoded.len(),
        digest(encoded)
    )
}

pub(super) fn preserve_arguments(parsed: &Value, arguments: &str) -> Result<String, BtccError> {
    let mut preserved = Map::new();
    if let Some(object) = parsed.as_object() {
        for key in ["path", "create_parents", "id", "kind", "project_ref"] {
            if let Some(value) = object.get(key) {
                preserved.insert(key.into(), value.clone());
            }
        }
    }
    preserved.insert(
        "omitted_arguments".into(),
        serde_json::from_str(&json_digest(arguments))
            .map_err(|error| BtccError::relayed("guided_prompt_json_invalid", error.to_string()))?,
    );
    encode(&Value::Object(preserved))
}
