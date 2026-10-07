//! Size-only surrogates for main's shared document budget. Never prompt content.
use super::{ConversationError, ConversationResult};
use rusqlite::{Connection, functions::FunctionFlags};
use serde_json::Value;

pub(super) fn register(db: &Connection) -> ConversationResult<()> {
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    db.create_scalar_function("history_budget_text", 1, flags, |ctx| {
        Ok(shape(ctx.get_raw(0).as_str().unwrap_or_default()))
    })
    .map_err(ConversationError::sqlite)?;
    db.create_scalar_function("history_budget_json", 1, flags, |ctx| {
        let mut value: Value = serde_json::from_str(ctx.get_raw(0).as_str().unwrap_or("null"))
            .map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))?;
        shape_value(&mut value);
        serde_json::to_string(&value).map_err(|e| rusqlite::Error::UserFunctionError(Box::new(e)))
    })
    .map_err(ConversationError::sqlite)
}

// Preserve UTF-8/UTF-16 widths, whitespace and JSON escape widths at every
// truncation boundary. Raw user text is never returned from SQLite for this path.
fn shape(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_whitespace() || c.is_control() || matches!(c, '"' | '\\' | '\u{feff}') {
                c
            } else {
                match c.len_utf8() {
                    1 => 'x',
                    2 => 'é',
                    3 => '漢',
                    _ => '😀',
                }
            }
        })
        .collect()
}

fn shape_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = shape(text),
        Value::Array(values) => values.iter_mut().for_each(shape_value),
        Value::Object(values) => {
            for (key, value) in values {
                // Keep validators' discriminants; their values carry no body.
                if !matches!(key.as_str(), "type" | "kind" | "revision") {
                    shape_value(value);
                }
            }
        }
        _ => {}
    }
}
