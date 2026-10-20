use serde_json::{Map, Value};

use super::validate::validate;

/// Decode one object, accepting a single JSON-string representation and fence.
pub fn decode_object(raw: &str) -> Option<Map<String, Value>> {
    let value: Value = serde_json::from_str(unfence(raw)).ok()?;
    let value = match value {
        Value::String(text) => serde_json::from_str(unfence(&text)).ok()?,
        other => other,
    };
    value.as_object().cloned()
}

fn unfence(text: &str) -> &str {
    let text = text.trim();
    if let Some(inner) = text.strip_prefix("```").and_then(|s| s.strip_suffix("```")) {
        let inner = inner.trim();
        inner.strip_prefix("json\n").unwrap_or(inner).trim()
    } else {
        text
    }
}

pub(super) fn arguments(tool: &str, schema: &Value, args: &Value, strict: bool) -> Value {
    let mut value = if let Some(text) = args.as_str() {
        serde_json::from_str(unfence(text))
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| args.clone())
    } else {
        args.clone()
    };
    if let Some(fields) = value.as_object()
        && fields.len() == 1
        && let Some((name, inner)) = fields.iter().next()
        && schema.get("properties").and_then(|p| p.get(name)).is_none()
        && (["arguments", "args", "parameters", "params", "input"].contains(&name.as_str())
            || name == tool)
        && inner.is_object()
        && validate(&value, schema, "$", tool, strict).is_err()
    {
        let mut candidate = inner.clone();
        normalize(&mut candidate, schema, strict);
        if validate(&candidate, schema, "$", tool, strict).is_ok() {
            value = candidate;
        }
    }
    normalize(&mut value, schema, strict);
    value
}

fn normalize(value: &mut Value, schema: &Value, strict: bool) {
    if let Some(variants) = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
    {
        let candidates: Vec<_> = variants
            .iter()
            .filter_map(|rule| {
                let mut candidate = value.clone();
                normalize(&mut candidate, rule, strict);
                validate(&candidate, rule, "$", "", strict)
                    .is_ok()
                    .then_some(candidate)
            })
            .collect();
        if let Some(first) = candidates.first()
            && candidates.iter().all(|candidate| candidate == first)
        {
            *value = first.clone();
        }
    }
    if validate(value, schema, "$", "", strict).is_err()
        && let Some(mut candidate) = representation(value, schema)
        && {
            normalize_children(&mut candidate, schema, strict);
            validate(&candidate, schema, "$", "", strict).is_ok()
        }
    {
        *value = candidate;
    }
    normalize_children(value, schema, strict);
}

fn normalize_children(value: &mut Value, schema: &Value, strict: bool) {
    if let Some(fields) = value.as_object_mut() {
        normalize_fields(fields, schema, strict);
    } else if let Some(items) = value.as_array_mut()
        && let Some(rule) = schema.get("items")
    {
        for item in items {
            normalize(item, rule, strict);
        }
    }
}

fn normalize_fields(fields: &mut Map<String, Value>, schema: &Value, strict: bool) {
    let properties = schema.get("properties").and_then(Value::as_object);
    fields.retain(|name, value| {
        let rule = properties.and_then(|p| p.get(name)).or_else(|| {
            strict
                .then(|| schema.get("additionalProperties").filter(|r| r.is_object()))
                .flatten()
        });
        let Some(rule) = rule else {
            return true;
        };
        if value.is_null() && has_type(rule) && !allows(rule, "null") {
            return false;
        }
        normalize(value, rule, strict);
        true
    });
}

fn has_type(schema: &Value) -> bool {
    schema.get("type").is_some()
        || ["oneOf", "anyOf"].iter().any(|key| {
            schema
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|rules| rules.iter().all(has_type))
        })
}

fn allows(schema: &Value, kind: &str) -> bool {
    schema
        .get("type")
        .is_some_and(|t| t == kind || t.as_array().is_some_and(|ts| ts.iter().any(|t| t == kind)))
        || ["oneOf", "anyOf"].iter().any(|key| {
            schema
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|rules| rules.iter().any(|rule| allows(rule, kind)))
        })
}

fn representation(value: &Value, schema: &Value) -> Option<Value> {
    if let Some(text) = value.as_str() {
        if let Some(options) = schema.get("enum").and_then(Value::as_array) {
            let matches: Vec<_> = options
                .iter()
                .filter(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(text)))
                .collect();
            if let [one] = matches.as_slice() {
                return Some((*one).clone());
            }
        }
        let parsed: Value = serde_json::from_str(text).ok()?;
        let kind = super::example::kind(&parsed);
        if allows(schema, kind) || kind == "number" && allows(schema, "integer") {
            return Some(parsed);
        }
    } else if value.is_number()
        && allows(schema, "string")
        && !allows(schema, "number")
        && !allows(schema, "integer")
    {
        return Some(Value::String(value.to_string()));
    }
    None
}
