use serde_json::{Map, Number, Value};

use super::super::contracts::CliFailure;

pub(super) fn required(options: &Value, key: &str) -> Result<String, CliFailure> {
    let value = options.get(key).and_then(Value::as_str).unwrap_or_default();
    let value = butler_core::public_text::trim_js_whitespace(value);
    if value.is_empty() {
        return Err(CliFailure::new(
            "invalid_arguments",
            format!("--{key} is required"),
        ));
    }
    Ok(value.to_owned())
}

pub(super) fn optional<'a>(options: &'a Value, key: &str) -> Option<&'a str> {
    options.get(key).and_then(Value::as_str).and_then(|value| {
        let value = butler_core::public_text::trim_js_whitespace(value);
        (!value.is_empty()).then_some(value)
    })
}

pub(super) fn body(options: &Value) -> Result<Option<String>, CliFailure> {
    let from = optional(options, "from");
    let literal = options.get("body").and_then(Value::as_str);
    if from.is_some() && literal.is_some() {
        return Err(CliFailure::new(
            "invalid_input",
            "--from and --body cannot be used together",
        ));
    }
    if let Some(body) = literal {
        if butler_core::public_text::trim_js_whitespace(body).is_empty() {
            return Err(CliFailure::new("invalid_input", "--body input is empty"));
        }
        return Ok(Some(body.to_owned()));
    }
    // The native ToolPort passes the source body inline. It does not publish
    // a temporary path or inherit a CLI stdin stream into the process owner.
    if from.is_some() {
        return Err(CliFailure::new(
            "invalid_input",
            "--from is unavailable in native tool calls",
        ));
    }
    Ok(None)
}

pub(super) fn safe_id(id: &str) -> Result<&str, CliFailure> {
    let value = butler_core::public_text::trim_js_whitespace(id);
    if value.is_empty()
        || matches!(value, "." | "..")
        || value.contains('/')
        || value.contains('\\')
    {
        return Err(CliFailure::new(
            "invalid_input",
            format!(
                "Invalid record id: {}",
                if value.is_empty() { "(empty)" } else { value }
            ),
        ));
    }
    Ok(value)
}

pub(super) fn updates(options: &Value, fields: &[&str]) -> Result<Map<String, Value>, CliFailure> {
    let mut updates = Map::new();
    for field in fields {
        if let Some(value) = optional(options, field) {
            updates.insert((*field).into(), Value::String(value.into()));
        }
    }
    for (option, field) in [
        ("code-commits", "codeCommits"),
        ("ledger-commits", "ledgerCommits"),
    ] {
        if let Some(value) = optional(options, option) {
            updates.insert(field.into(), Value::String(value.into()));
        }
    }
    if optional(options, "code-commit") == Some("auto") {
        // Host expands the source Git evidence before reaching this domain.
        return Err(CliFailure::new(
            "invalid_input",
            "code-commit auto requires normalized Git evidence",
        ));
    }
    for (option, field) in [
        ("spec-exemption", "specExemption"),
        ("acceptance-exemption", "acceptanceExemption"),
        ("requires-commit-evidence", "requiresCommitEvidence"),
    ] {
        if super::super::option_truthy(options, option) {
            updates.insert(field.into(), Value::Bool(true));
        }
    }
    for field in ["priority", "revision", "supersedesRevision"] {
        if let Some(value) = options.get(field) {
            updates.insert(field.into(), Value::Number(number_option(value, field)?));
        }
    }
    Ok(updates)
}

/// A numeric option as JSON: an integer when it is one, else a float.
fn number_option(value: &Value, field: &str) -> Result<Number, CliFailure> {
    let invalid = || CliFailure::new("invalid_arguments", format!("--{field} must be a number"));
    let number =
        butler_core::json::coerce_number(value).map_err(|source| invalid().with_source(source))?;
    if !number.is_finite() {
        return Err(invalid());
    }
    if number.fract() == 0.0 && number >= i64::MIN as f64 && number < i64::MAX as f64 {
        return Ok(Number::from(butler_core::json::saturating_i64(number)));
    }
    Number::from_f64(number).ok_or_else(invalid)
}
