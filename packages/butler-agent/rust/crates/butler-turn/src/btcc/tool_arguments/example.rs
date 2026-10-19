use serde_json::{Map, Value, json};

pub(super) fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

pub(super) fn type_name(schema: &Value) -> String {
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        return options
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("|");
    }
    declared_type(schema)
}

pub(super) fn declared_type(schema: &Value) -> String {
    match schema.get("type") {
        Some(Value::String(name)) => name.clone(),
        Some(Value::Array(names)) => names
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" or "),
        _ => {
            let Some(variants) = schema
                .get("oneOf")
                .or_else(|| schema.get("anyOf"))
                .and_then(Value::as_array)
            else {
                return "object".into();
            };
            let mut types = Vec::new();
            for variant in variants {
                let kind = declared_type(variant);
                if !types.contains(&kind) {
                    types.push(kind);
                }
            }
            types.join(" or ")
        }
    }
}

pub(super) fn parameters(schema: &Value) -> String {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, rule)| {
            let required = if required(schema, name) {
                ", required"
            } else {
                ""
            };
            format!("{name} ({}{required})", type_name(rule))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub(super) fn required(schema: &Value, name: &str) -> bool {
    schema
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|names| names.iter().any(|n| n == name))
}

pub(super) fn example(schema: &Value, name: &str) -> Value {
    if schema.get("type").is_none()
        && let Some(variant) = schema
            .get("oneOf")
            .or_else(|| schema.get("anyOf"))
            .and_then(Value::as_array)
            .and_then(|variants| variants.first())
    {
        return example(variant, name);
    }
    let kind = schema
        .get("type")
        .and_then(|kind| {
            kind.as_str().or_else(|| {
                let types = kind.as_array()?;
                types
                    .iter()
                    .filter_map(Value::as_str)
                    .find(|kind| *kind != "null")
                    .or_else(|| types.first().and_then(Value::as_str))
            })
        })
        .unwrap_or("object");
    match kind {
        "string" => schema
            .get("enum")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
            .cloned()
            .unwrap_or_else(|| json!(format!("<{name}>"))),
        "integer" | "number" => schema
            .get("default")
            .or_else(|| schema.get("minimum"))
            .cloned()
            .unwrap_or(json!(0)),
        "boolean" => schema.get("default").cloned().unwrap_or(json!(false)),
        "null" => Value::Null,
        "array" => {
            let count = schema.get("minItems").and_then(Value::as_u64).unwrap_or(0);
            Value::Array(
                (0..count)
                    .map(|_| example(&schema["items"], name))
                    .collect(),
            )
        }
        _ => {
            let fields: Map<_, _> = schema
                .get("properties")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .filter(|(name, _)| required(schema, name))
                .map(|(name, rule)| (name.clone(), example(rule, name)))
                .collect();
            Value::Object(fields)
        }
    }
}

pub(super) fn preview(value: &Value) -> String {
    let raw = if let Some(text) = value.as_str() {
        json!(text.chars().take(40).collect::<String>()).to_string()
    } else {
        value.to_string()
    };
    if raw.chars().count() <= 40 {
        return raw;
    }
    let mut text: String = value.as_str().unwrap_or(&raw).chars().take(38).collect();
    while json!(text).to_string().chars().count() > 40 {
        text.pop();
    }
    json!(text).to_string()
}

pub(super) fn close<'a>(name: &str, properties: &'a Map<String, Value>) -> Option<&'a str> {
    fn key(name: &str) -> String {
        let name = name.to_ascii_lowercase().replace(['_', '-'], "");
        name.strip_suffix("id").unwrap_or(&name).to_owned()
    }
    let matches: Vec<_> = properties.keys().filter(|n| key(n) == key(name)).collect();
    match matches.as_slice() {
        [one] => Some(one.as_str()),
        _ => None,
    }
}

pub(super) fn unexpected(
    tool: &str,
    name: &str,
    properties: Option<&Map<String, Value>>,
) -> String {
    let suffix = properties
        .and_then(|p| close(name, p))
        .map(|close| format!(" (did you mean \"{close}\"?)"))
        .unwrap_or_default();
    format!("\"{name}\" is not an argument of {tool}{suffix}")
}
