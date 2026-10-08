//! Anthropic accepts ordinary JSON Schema, but forbids root combinators.
//! Strict-tool restrictions do not apply: we do not send `strict: true`.
//! Local $ref/definitions and nested constraints remain intact.
use std::collections::BTreeSet;

use butler_turn::btcc::ModelRoundTool;
use serde_json::{Map, Value, json};

const COMBINATORS: [&str; 3] = ["oneOf", "anyOf", "allOf"];

pub(super) fn tool(tool: &ModelRoundTool) -> Value {
    let mut schema = tool.parameters.clone();
    let constraints: Map<String, Value> = COMBINATORS
        .iter()
        .filter_map(|key| schema.get(*key).map(|value| ((*key).into(), value.clone())))
        .collect();
    let description = if constraints.is_empty() {
        tool.description.clone()
    } else {
        format!(
            "{}\nInput variant constraints (original JSON Schema; obey these when choosing arguments): {}",
            tool.description,
            Value::Object(constraints)
        )
    };
    flatten(&mut schema);
    json!({"name":tool.name,"description":description,"input_schema":schema})
}

fn flatten(schema: &mut Map<String, Value>) {
    schema.insert("type".into(), "object".into());
    let mut properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut required = required_names(schema);
    for keyword in COMBINATORS {
        let Some(Value::Array(branches)) = schema.shift_remove(keyword) else {
            continue;
        };
        let mut common: Option<BTreeSet<String>> = None;
        for branch in branches {
            let Some(mut branch) = branch.as_object().cloned() else {
                if keyword != "allOf" {
                    common = Some(BTreeSet::new());
                }
                continue;
            };
            flatten(&mut branch);
            let names = required_names(&branch);
            common = Some(match common {
                Some(previous) if keyword == "allOf" => previous.union(&names).cloned().collect(),
                Some(previous) => previous.intersection(&names).cloned().collect(),
                None => names,
            });
            if let Some(fields) = branch.get("properties").and_then(Value::as_object) {
                for (name, field) in fields {
                    merge_property(&mut properties, name, field);
                }
            }
        }
        required.extend(common.unwrap_or_default());
    }
    schema.insert("properties".into(), properties.into());
    if schema.contains_key("required") || !required.is_empty() {
        schema.insert("required".into(), json!(required));
    }
}

fn required_names(schema: &Map<String, Value>) -> BTreeSet<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn merge_property(properties: &mut Map<String, Value>, name: &str, field: &Value) {
    let Some(previous) = properties.get_mut(name) else {
        properties.insert(name.into(), field.clone());
        return;
    };
    if previous == field {
        return;
    }
    // A base property's schema and every variant stay available. Nested anyOf
    // is accepted by Anthropic; unlike overwriting, it loses no variant types.
    *previous = json!({"anyOf":[previous.clone(), field]});
}
