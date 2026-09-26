use super::super::{invalid, required_string};
use crate::project_ledger::ProjectLedgerReadError;
use serde_json::Value;

pub(super) fn identity(value: &Value) -> Result<(), ProjectLedgerReadError> {
    exact(
        object(Some(value))?,
        &["kind", "id", "requestSha256"],
        &["mutationCallId"],
    )?;
    let kind = required_string(value, "kind")?;
    let id = required_string(value, "id")?;
    if !matches!(
        kind,
        "mutation_call"
            | "binding_revision"
            | "closeout_diagnostic"
            | "abandonment"
            | "legacy_import"
    ) {
        return Err(invalid());
    }
    digest(value.get("requestSha256"))?;
    if kind == "mutation_call" {
        if value.get("mutationCallId").and_then(Value::as_str) != Some(id) {
            return Err(invalid());
        }
    } else if value.get("mutationCallId").is_some() {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn progress_value(value: &Value) -> Result<(), ProjectLedgerReadError> {
    exact(object(Some(value))?, &["actionKey", "status"], &["note"])?;
    required_string(value, "actionKey")?;
    if !matches!(
        value.get("status").and_then(Value::as_str),
        Some("pending" | "active" | "done" | "blocked" | "skipped")
    ) {
        return Err(invalid());
    }
    if value.get("note").is_some_and(|note| {
        note.as_str()
            .is_none_or(|text| text.encode_utf16().count() > 16384)
    }) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn stage_value(value: &Value) -> Result<(), ProjectLedgerReadError> {
    if matches!(
        value.as_str(),
        Some("conception" | "planning" | "execution" | "review" | "validation" | "reporting")
    ) {
        Ok(())
    } else {
        Err(invalid())
    }
}

pub(super) fn strings(value: &Value) -> Result<(), ProjectLedgerReadError> {
    for item in array(Some(value))? {
        if item.as_str().is_none_or(|text| {
            crate::public_text::trim_js_whitespace(text).is_empty()
                || text.encode_utf16().count() > 4096
        }) {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) fn array(value: Option<&Value>) -> Result<&[Value], ProjectLedgerReadError> {
    value
        .and_then(Value::as_array)
        .filter(|items| items.len() <= 512)
        .map(Vec::as_slice)
        .ok_or_else(invalid)
}

pub(super) fn object(
    value: Option<&Value>,
) -> Result<&serde_json::Map<String, Value>, ProjectLedgerReadError> {
    value.and_then(Value::as_object).ok_or_else(invalid)
}

pub(super) fn exact(
    object: &serde_json::Map<String, Value>,
    required: &[&str],
    optional: &[&str],
) -> Result<(), ProjectLedgerReadError> {
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn positive(value: &Value, key: &str) -> Result<(), ProjectLedgerReadError> {
    if value
        .get(key)
        .and_then(Value::as_u64)
        .is_none_or(|number| number == 0)
    {
        Err(invalid())
    } else {
        Ok(())
    }
}

pub(super) fn digest(value: Option<&Value>) -> Result<(), ProjectLedgerReadError> {
    if value.and_then(Value::as_str).is_none_or(|value| {
        value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        Err(invalid())
    } else {
        Ok(())
    }
}
