use indexmap::IndexMap;
use serde_json::Value;

use crate::cognition::{CognitionError, CognitionResult};

pub(super) fn validate(
    requirement: &Value,
    refs: &IndexMap<String, String>,
) -> CognitionResult<()> {
    let o = requirement.as_object().ok_or_else(invalid)?;
    let Some(condition) = o.get("condition") else {
        return Err(invalid());
    };
    if o.len() != 2
        || !o.contains_key("action")
        || o.get("action")
            .and_then(Value::as_str)
            .is_none_or(|action| action.trim().is_empty())
    {
        return Err(invalid());
    }
    let mut atoms = 0;
    visit(condition, refs, 0, &mut atoms)
}
fn visit(
    value: &Value,
    refs: &IndexMap<String, String>,
    depth: usize,
    atoms: &mut usize,
) -> CognitionResult<()> {
    if depth > 4 {
        return Err(invalid());
    }
    let o = value.as_object().ok_or_else(invalid)?;
    if o.contains_key("subject") {
        if o.len() != 2
            || !o.contains_key("state")
            || o.get("state")
                .and_then(Value::as_str)
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(invalid());
        }
        if let Some(reference) = o.get("subject").and_then(Value::as_str) {
            if !refs.contains_key(reference) {
                return Err(CognitionError::new(
                    "memory_extract_invalid_ref",
                    "memory_extract_invalid_ref",
                ));
            }
        } else if !o.get("subject").is_some_and(Value::is_null) {
            return Err(invalid());
        }
        *atoms += 1;
        if *atoms > 16 {
            return Err(invalid());
        }
    } else if let Some(negated) = o.get("not") {
        if o.len() != 1 {
            return Err(invalid());
        }
        visit(negated, refs, depth + 1, atoms)?;
    } else {
        let key = if o.contains_key("all") {
            "all"
        } else if o.contains_key("any") {
            "any"
        } else {
            return Err(invalid());
        };
        if o.len() != 1 {
            return Err(invalid());
        }
        let children = o.get(key).and_then(Value::as_array).ok_or_else(invalid)?;
        if children.is_empty() || children.len() > 16 {
            return Err(invalid());
        }
        for child in children {
            visit(child, refs, depth + 1, atoms)?;
        }
    }
    Ok(())
}
fn invalid() -> CognitionError {
    CognitionError::new(
        "memory_extract_invalid_condition",
        "memory_extract_invalid_condition",
    )
}
