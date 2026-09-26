use std::borrow::Cow;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

use super::super::contracts::CliFailure;

pub(super) fn create(
    path: &Path,
    metadata: Map<String, Value>,
    body: Option<&str>,
) -> Result<(), CliFailure> {
    let body = match body {
        Some(body) => Cow::Borrowed(body),
        None => {
            let title = metadata
                .get("title")
                .or_else(|| metadata.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            Cow::Owned(format!("# {title}\n\nManaged by Project Ledger."))
        }
    };
    write(path, metadata, &body)
}

pub(super) fn update(
    path: &Path,
    updates: &Map<String, Value>,
    body_override: Option<&str>,
) -> Result<(), CliFailure> {
    let original = fs::read_to_string(path).map_err(|_| super::super::io_failure())?;
    let metadata = if path.extension().and_then(|part| part.to_str()) == Some("json") {
        serde_json::from_str::<Value>(&original)
            .map_err(|error| {
                CliFailure::new(
                    "invalid_json",
                    format!("Invalid JSON at {}: {error}", path.display()),
                )
            })?
            .as_object()
            .cloned()
            .unwrap_or_default()
    } else {
        crate::project_ledger::records::frontmatter(&original)
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default()
    };
    let existing_body = crate::project_ledger::records::frontmatter_body_ref(&original);
    let body = if let Some(body) = body_override {
        Cow::Borrowed(body)
    } else if !existing_body.is_empty() {
        Cow::Borrowed(existing_body)
    } else {
        let title = updates
            .get("title")
            .or_else(|| metadata.get("title"))
            .or_else(|| metadata.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        Cow::Owned(format!("# {title}\n"))
    };
    let mut metadata = metadata;
    metadata.extend(updates.clone());
    write(path, metadata, &body)
}

fn write(path: &Path, mut metadata: Map<String, Value>, body: &str) -> Result<(), CliFailure> {
    metadata.insert("updatedAt".into(), Value::String(super::super::now_iso()?));
    let mut output = String::with_capacity(body.len() + metadata.len() * 64 + 16);
    output.push_str("---\n");
    for (key, value) in metadata {
        if value.is_null() || value.as_str() == Some("") {
            continue;
        }
        output.push_str(&key);
        output.push_str(": ");
        match value {
            Value::Bool(value) => output.push_str(if value { "true" } else { "false" }),
            Value::Number(value) => output.push_str(
                &crate::json::stringify(&Value::Number(value))
                    .map_err(|_| super::super::io_failure())?,
            ),
            other => {
                let text = js_string(&other)?;
                output.push_str(
                    &crate::json::stringify(&Value::String(text))
                        .map_err(|_| super::super::io_failure())?,
                );
            }
        }
        output.push('\n');
    }
    output.push_str("---\n\n");
    output.push_str(body);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| super::super::io_failure())?;
    }
    fs::write(path, output).map_err(|_| super::super::io_failure())
}

pub(super) fn append_event(root: &Path, event: &Value) -> Result<(), CliFailure> {
    let mut record = Map::new();
    record.insert(
        "schema".into(),
        Value::String("project-ledger.event.v1".into()),
    );
    record.insert("ts".into(), Value::String(super::super::now_iso()?));
    record.extend(
        event
            .as_object()
            .cloned()
            .ok_or_else(super::super::io_failure)?,
    );
    let line =
        crate::json::stringify(&Value::Object(record)).map_err(|_| super::super::io_failure())?;
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(root.join("ledger.jsonl"))
        .map_err(|_| super::super::io_failure())?;
    file.write_all(line.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|_| super::super::io_failure())
}

pub(super) fn epoch_millis_string() -> Result<String, CliFailure> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| super::super::io_failure())?;
    Ok(elapsed.as_millis().to_string())
}

fn js_string(value: &Value) -> Result<String, CliFailure> {
    match value {
        Value::String(value) => Ok(value.clone()),
        Value::Null => Ok("null".into()),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(_) => crate::json::stringify(value).map_err(|_| super::super::io_failure()),
        Value::Array(values) => {
            let mut output = String::new();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                if !value.is_null() {
                    output.push_str(&js_string(value)?);
                }
            }
            Ok(output)
        }
        Value::Object(_) => Ok("[object Object]".into()),
    }
}
