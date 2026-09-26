//! Executable native next steps for source Project Ledger CLI errors.

use serde_json::{Map, Value, json};

use crate::public_text::trim_js_whitespace;

pub(super) fn attach(name: &str, args: &Map<String, Value>, mut result: Value) -> Value {
    let Some(output) = result.as_object_mut() else {
        return result;
    };
    if output.get("ok") != Some(&Value::Bool(false)) {
        return result;
    }
    let Some(error) = output.get("error").and_then(Value::as_object) else {
        return result;
    };
    let hints = native_next(error, name, args);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if hints.is_empty() {
        if matches!(
            code,
            "invalid_input"
                | "invalid_arguments"
                | "invalid_state"
                | "invalid_transition"
                | "completion_gate_failed"
        ) {
            output.insert("recoverable".into(), Value::Bool(true));
        }
        return result;
    }
    output.insert("recoverable".into(), Value::Bool(true));
    if let Some(error) = output.get_mut("error").and_then(Value::as_object_mut) {
        error.insert("native_next".into(), Value::Array(hints));
    }
    result
}

fn native_next(error: &Map<String, Value>, name: &str, args: &Map<String, Value>) -> Vec<Value> {
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut scope = Map::new();
    if let Some(project_ref) = text(args.get("project_ref")) {
        scope.insert("project_ref".into(), project_ref.into());
    }
    if let Some(next) = error.get("next").and_then(Value::as_array) {
        for item in next {
            let command = item
                .as_str()
                .or_else(|| item.get("command").and_then(Value::as_str));
            if command.is_some_and(index_command) {
                return vec![hint(
                    "project_ledger_index",
                    &Value::Object(scope),
                    "Rebuild the compact Project Ledger index for this project.",
                )];
            }
        }
    }
    if matches!(code, "record_not_found" | "ambiguous_record") {
        scope.insert("kind".into(), "all".into());
        return vec![hint(
            "project_ledger_list",
            &Value::Object(scope),
            "List records, then retry with the exact id and kind.",
        )];
    }
    if code == "project_ledger_check_failed" {
        return vec![hint(
            "project_ledger_check",
            &Value::Object(scope),
            "Review data.issues, repair source records, and rerun validation.",
        )];
    }
    let Some(id) = text(args.get("id")) else {
        return Vec::new();
    };
    if name == "project_ledger_create"
        || !matches!(
            code,
            "invalid_state"
                | "invalid_transition"
                | "completion_gate_failed"
                | "invalid_input"
                | "invalid_arguments"
        )
    {
        return Vec::new();
    }
    scope.insert("id".into(), id.into());
    let kind = text(args.get("kind")).or_else(|| lifecycle_kind(name));
    if let Some(kind) = kind {
        scope.insert("kind".into(), kind.into());
    }
    vec![hint(
        "project_ledger_show",
        &Value::Object(scope),
        "Inspect the record, correct the reported arguments or missing evidence, and retry the original lifecycle action.",
    )]
}

fn hint(tool: &str, args: &Value, reason: &str) -> Value {
    json!({"tool":tool,"args":args,"reason":reason})
}

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty())
}

fn lifecycle_kind(name: &str) -> Option<&'static str> {
    ["work", "task", "attempt"].into_iter().find(|kind| {
        name.strip_prefix("project_ledger_")
            .and_then(|name| name.strip_prefix(*kind))
            .is_some_and(|tail| tail.starts_with('_'))
    })
}

fn index_command(command: &str) -> bool {
    let command = trim_js_whitespace(command);
    let tail = command
        .strip_prefix("project-ledger index")
        .or_else(|| command.strip_prefix("pl index"));
    tail.is_some_and(|tail| {
        tail.is_empty()
            || tail.chars().next().is_some_and(|character| {
                let mut bytes = [0; 4];
                trim_js_whitespace(character.encode_utf8(&mut bytes)).is_empty()
            })
    })
}
