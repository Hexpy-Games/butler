//! Evidence appears once in the provider view; the journal keeps the exact JSON.
use butler_turn::btcc::BtccError;
use serde_json::{Value, json};

pub(super) fn project(raw: &str) -> Result<String, BtccError> {
    let mut value: Value =
        serde_json::from_str(raw).map_err(|e| super::failure().with_source(e))?;
    let Some(object) = value.as_object_mut() else {
        return Ok(raw.into());
    };
    for key in ["duration_ms", "effective_max_chars", "effective_max_chunks"] {
        object.remove(key);
    }
    for (key, empty) in [
        ("warnings", json!([])),
        ("error", Value::Null),
        ("render_recommended", json!(false)),
    ] {
        if object.get(key) == Some(&empty) {
            object.remove(key);
        }
    }
    for key in ["source_url", "requested_url"] {
        if object.get(key) == object.get("final_url") {
            object.remove(key);
        }
    }
    if object.contains_key("passages") {
        object.remove("markdown");
        object.remove("chunks");
    }
    if let Some(chunks) = object.get_mut("chunks").and_then(Value::as_array_mut) {
        for chunk in chunks {
            if let Some(meta) = chunk.as_object_mut() {
                meta.retain(|key, _| matches!(key.as_str(), "id" | "index"));
            }
        }
    }
    serde_json::to_string(&value).map_err(|e| super::failure().with_source(e))
}
