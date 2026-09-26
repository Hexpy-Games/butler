use std::{collections::HashSet, path::Path};

use serde_json::{Map, Value};

pub(super) fn first_by_key<T, K: Eq + std::hash::Hash>(
    values: impl Iterator<Item = T>,
    key: impl Fn(&T) -> K,
) -> Vec<T> {
    let mut seen = HashSet::new();
    values.filter(|value| seen.insert(key(value))).collect()
}

pub(super) fn array(value: Option<&Value>) -> &[Value] {
    value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub(super) fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
}

/// Runtime routing uses nullish precedence before string validation.
pub(super) fn configured_default(config: &Value) -> Option<&str> {
    text(
        config
            .pointer("/system/butlerModel")
            .filter(|value| !value.is_null())
            .or_else(|| config.pointer("/system/defaultModel")),
    )
}

/// App listing's existing default reader validates each candidate separately.
pub(super) fn app_default(config: &Value) -> Option<&str> {
    text(config.pointer("/system/butlerModel"))
        .or_else(|| text(config.pointer("/system/defaultModel")))
}

pub(super) async fn read_object(path: &Path) -> Value {
    // Source readJsonObject catches read/parse failures and returns an empty
    // object. This path never repairs, deletes or rewrites original file bytes.
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(_) => return Value::Object(Map::new()),
    };
    serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

pub(super) fn read_object_sync(path: &Path) -> Value {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Value::Object(Map::new()),
    };
    serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}
