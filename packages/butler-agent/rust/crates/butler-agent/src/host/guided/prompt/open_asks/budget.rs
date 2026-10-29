//! Bound the volatile JSON while retaining every selected open ask's identity.
use butler_turn::btcc::BtccError;
use serde_json::{Value, json};

const MAX_BYTES: usize = 1600;

pub(super) fn encode(mut content: Value) -> Result<String, BtccError> {
    // Missing optional fields have the same meaning as null. Keep the fixed
    // identity metadata small enough to retain all eight open asks.
    for key in ["open", "settled"] {
        for entry in content[key].as_array_mut().into_iter().flatten() {
            if let Some(fields) = entry.as_object_mut() {
                fields.retain(|_, value| !value.is_null());
            }
        }
    }
    for field in ["/response/answer", "/title"] {
        if encoded(&content)?.len() <= MAX_BYTES {
            return encoded(&content);
        }
        trim(&mut content, field)?;
    }
    while encoded(&content)?.len() > MAX_BYTES {
        let settled = content["settled"]
            .as_array_mut()
            .ok_or_else(|| invalid("missing settled entries"))?;
        if settled.pop().is_none() {
            return Err(invalid("open ask identities exceed the JSON budget"));
        }
        content["settled_more"] = json!(content["settled_more"].as_u64().unwrap_or(0) + 1);
    }
    encoded(&content)
}

fn trim(content: &mut Value, field: &str) -> Result<(), BtccError> {
    let original = content.clone();
    let mut low = 0;
    let mut high = ["open", "settled"]
        .into_iter()
        .flat_map(|key| original[key].as_array().into_iter().flatten())
        .filter_map(|entry| entry.pointer(field).and_then(Value::as_str))
        .map(|text| text.chars().count())
        .max()
        .unwrap_or(0);
    // If even empty text cannot fit, the next field (then settled entries)
    // must shrink. Otherwise find the longest common character cap that fits.
    *content = capped(&original, field, 0);
    while low < high {
        let cap = low + (high - low).div_ceil(2);
        let candidate = capped(&original, field, cap);
        if encoded(&candidate)?.len() <= MAX_BYTES {
            low = cap;
            *content = candidate;
        } else {
            high = cap - 1;
        }
    }
    Ok(())
}

fn capped(original: &Value, field: &str, cap: usize) -> Value {
    let mut content = original.clone();
    for key in ["open", "settled"] {
        for entry in content[key].as_array_mut().into_iter().flatten() {
            if let Some(value) = entry.pointer_mut(field)
                && let Some(text) = value.as_str()
                && text.chars().count() > cap
            {
                let mut summary = text.chars().take(cap.saturating_sub(1)).collect::<String>();
                if cap > 0 {
                    summary.push('…');
                }
                *value = json!(summary);
            }
        }
    }
    content
}

fn encoded(content: &Value) -> Result<String, BtccError> {
    serde_json::to_string(content).map_err(|error| invalid(&error.to_string()))
}
fn invalid(message: &str) -> BtccError {
    BtccError::relayed("ask_reminders_invalid", message)
}
