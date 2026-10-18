//! Gemini JSON Schema mode accepts only documented keywords. Inline local refs,
//! project subschemas, and retain unsupported constraints in descriptions;
//! runtime handlers still validate arguments against the original full schema.
use std::collections::BTreeSet;

use butler_turn::btcc::ModelRoundTool;
use serde_json::{Map, Value, json};

pub(super) fn tool(tool: &ModelRoundTool) -> Value {
    let root = Value::Object(tool.parameters.clone());
    let mut schema = project(&root, &root, &mut BTreeSet::new());
    schema["type"] = json!("object");
    json!({"name":tool.name,"description":tool.description,"parametersJsonSchema":schema})
}

fn project(node: &Value, root: &Value, active: &mut BTreeSet<String>) -> Value {
    let Some(source) = node.as_object() else {
        return if node == &Value::Bool(true) {
            json!({})
        } else {
            json!({"description":format!("Constraints: {node}")})
        };
    };
    let mut output = Map::new();
    let mut constraints = Map::new();
    for (key, value) in source {
        match key.as_str() {
            "$defs" | "definitions" | "$schema" | "$id" | "$comment" | "$ref" | "allOf"
            | "oneOf" | "const" => {}
            _ => match keyword(key, value, root, active) {
                Some(value) => {
                    output.insert(key.clone(), value);
                }
                None => {
                    constraints.insert(key.clone(), value.clone());
                }
            },
        }
    }
    if let Some(branches) = source.get("oneOf").and_then(Value::as_array) {
        let any = output.entry("anyOf").or_insert_with(|| json!([]));
        if let Some(any) = any.as_array_mut() {
            any.extend(branches.iter().map(|branch| project(branch, root, active)));
        }
    }
    if let Some(value) = source.get("const") {
        replace_const(&mut output, value, &mut constraints);
    }
    if let Some(reference) = source.get("$ref") {
        inline_ref(&mut output, reference, root, active, &mut constraints);
    }
    if let Some(all) = source.get("allOf") {
        let mut merged = output.clone();
        let branches = all.as_array();
        if branches.is_some_and(|branches| {
            branches
                .iter()
                .all(|branch| merge(&mut merged, &project(branch, root, active)))
        }) {
            output = merged;
        } else {
            constraints.insert("allOf".into(), all.clone());
        }
    }
    if !constraints.is_empty() {
        note(
            &mut output,
            &format!("Constraints: {}", Value::Object(constraints)),
        );
    }
    Value::Object(output)
}

fn keyword(key: &str, value: &Value, root: &Value, active: &mut BTreeSet<String>) -> Option<Value> {
    Some(match key {
        "properties" => Value::Object(
            value
                .as_object()
                .into_iter()
                .flatten()
                .map(|(name, schema)| (name.clone(), project(schema, root, active)))
                .collect(),
        ),
        "items" => project(value, root, active),
        "additionalProperties" if value.is_object() => project(value, root, active),
        "prefixItems" | "anyOf" => Value::Array(
            value
                .as_array()
                .into_iter()
                .flatten()
                .map(|schema| project(schema, root, active))
                .collect(),
        ),
        "type"
        | "title"
        | "description"
        | "required"
        | "additionalProperties"
        | "enum"
        | "format"
        | "minimum"
        | "maximum"
        | "minItems"
        | "maxItems" => value.clone(),
        _ => return None,
    })
}

fn inline_ref(
    output: &mut Map<String, Value>,
    reference: &Value,
    root: &Value,
    active: &mut BTreeSet<String>,
    constraints: &mut Map<String, Value>,
) {
    let Some(path) = reference
        .as_str()
        .filter(|path| path.starts_with("#/$defs/") || path.starts_with("#/definitions/"))
    else {
        constraints.insert("$ref".into(), reference.clone());
        return;
    };
    if !active.insert(path.to_owned()) {
        note(output, &format!("Recursive reference: {path}"));
        return;
    }
    if let Some(target) = root.pointer(&path[1..]) {
        let projected = project(target, root, active);
        if !merge(output, &projected) {
            note(output, &format!("Reference constraints: {projected}"));
        }
    } else {
        constraints.insert("$ref".into(), reference.clone());
    }
    active.remove(path);
}

// Conservative conjunction: conflicts stay described rather than overwriting a constraint.
fn merge(target: &mut Map<String, Value>, other: &Value) -> bool {
    let Some(other) = other.as_object() else {
        return false;
    };
    if closed_conflict(target, other) || closed_conflict(other, target) {
        return false;
    }
    let mut merged = target.clone();
    for (key, value) in other {
        let Some(previous) = merged.get_mut(key) else {
            merged.insert(key.clone(), value.clone());
            continue;
        };
        if previous == value {
            continue;
        }
        match key.as_str() {
            "description" => {
                *previous = json!(format!(
                    "{}\n{}",
                    previous.as_str().unwrap_or_default(),
                    value.as_str().unwrap_or_default()
                ));
            }
            "required" if previous.is_array() && value.is_array() => {
                let mut names = previous.as_array().cloned().unwrap_or_default();
                for name in value.as_array().into_iter().flatten() {
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
                *previous = names.into();
            }
            "properties" => {
                let Some(properties) = previous.as_object_mut() else {
                    return false;
                };
                let Some(fields) = value.as_object() else {
                    return false;
                };
                for (name, field) in fields {
                    if properties
                        .get(name)
                        .is_some_and(|previous| previous != field)
                    {
                        return false;
                    }
                    properties.insert(name.clone(), field.clone());
                }
            }
            _ => return false,
        }
    }
    *target = merged;
    true
}

fn note(schema: &mut Map<String, Value>, text: &str) {
    let description = schema.entry("description").or_insert_with(|| json!(""));
    let previous = description.as_str().unwrap_or_default();
    *description = json!(if previous.is_empty() {
        text.to_owned()
    } else {
        format!("{previous}\n{text}")
    });
}

fn replace_const(
    output: &mut Map<String, Value>,
    value: &Value,
    constraints: &mut Map<String, Value>,
) {
    if let Some(enumeration) = output.insert("enum".into(), json!([value])) {
        constraints.insert("enum".into(), enumeration);
    }
}

fn closed_conflict(closed: &Map<String, Value>, other: &Map<String, Value>) -> bool {
    closed.get("additionalProperties") == Some(&Value::Bool(false))
        && other
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|fields| {
                fields.keys().any(|name| {
                    closed
                        .get("properties")
                        .and_then(Value::as_object)
                        .is_none_or(|properties| !properties.contains_key(name))
                })
            })
}
