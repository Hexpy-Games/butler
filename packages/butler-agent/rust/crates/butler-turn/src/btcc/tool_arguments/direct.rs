//! Direct-call representation repair never uses catalog value constraints.
use serde_json::Value;

use super::{normalize, validate};

pub(super) fn arguments(tool: &str, schema: &Value, args: &Value) -> Value {
    let mut value = args
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| args.clone());
    if let Some(fields) = value.as_object()
        && fields.len() == 1
        && validate::required_fields(fields, schema, "$", tool).is_err()
        && let Some((name, inner)) = fields.iter().next()
        && schema.get("properties").and_then(|p| p.get(name)).is_none()
        && (["arguments", "args", "parameters", "params", "input"].contains(&name.as_str())
            || name == tool)
        && let Some(fields) = inner.as_object()
        && validate::required_fields(fields, schema, "$", tool).is_ok()
    {
        value = inner.clone();
    }
    repair(&mut value, schema);
    value
}

fn repair(value: &mut Value, schema: &Value) {
    if let Some(candidate) = representation(value, schema) {
        *value = candidate;
    }
    if let Some(fields) = value.as_object_mut() {
        fields.retain(|name, value| {
            let Some(rule) = schema.get("properties").and_then(|p| p.get(name)) else {
                return true;
            };
            let required = required_in_variant(schema, name);
            if value.is_null()
                && !required
                && normalize::has_type(rule)
                && !normalize::allows(rule, "null")
            {
                return false;
            }
            repair(value, rule);
            true
        });
    } else if let Some(items) = value.as_array_mut()
        && let Some(rule) = schema.get("items")
    {
        for item in items {
            repair(item, rule);
        }
    }
    repair_variants(value, schema);
}

fn required_in_variant(schema: &Value, name: &str) -> bool {
    super::example::required(schema, name)
        || ["oneOf", "anyOf", "allOf"].iter().any(|key| {
            schema
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|rules| rules.iter().any(|rule| required_in_variant(rule, name)))
        })
}

fn repair_variants(value: &mut Value, schema: &Value) {
    for key in ["oneOf", "anyOf"] {
        let Some(rules) = schema.get(key).and_then(Value::as_array) else {
            continue;
        };
        let candidates: Vec<_> = rules
            .iter()
            .filter(|rule| {
                !normalize::has_type(rule)
                    || normalize::allows(rule, super::example::kind(value))
                    || value.is_number() && normalize::allows(rule, "integer")
            })
            .map(|rule| {
                let mut candidate = value.clone();
                repair(&mut candidate, rule);
                candidate
            })
            .collect();
        if let Some(first) = candidates.first()
            && candidates.iter().all(|candidate| candidate == first)
        {
            *value = first.clone();
        }
    }
}

fn representation(value: &Value, schema: &Value) -> Option<Value> {
    let text = value.as_str()?;
    if let Some(options) = schema.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        let mut matches = options
            .iter()
            .filter(|v| v.as_str().is_some_and(|s| s.eq_ignore_ascii_case(text)));
        if let Some(one) = matches.next()
            && matches.next().is_none()
        {
            return Some(one.clone());
        }
    }
    // A declared string or an untyped branch may already be handler-owned.
    if !normalize::has_type(schema) || normalize::allows(schema, "string") {
        return None;
    }
    let parsed: Value = serde_json::from_str(text).ok()?;
    let allowed = match &parsed {
        Value::Number(_) => {
            (normalize::allows(schema, "number") || normalize::allows(schema, "integer"))
                && decimal(text)
                    .is_some_and(|original| Some(original) == decimal(&parsed.to_string()))
        }
        Value::Bool(_) => normalize::allows(schema, "boolean"),
        Value::Object(_) => normalize::allows(schema, "object"),
        Value::Array(_) => normalize::allows(schema, "array"),
        _ => false,
    };
    allowed.then_some(parsed)
}

// Compare decimal values exactly, without letting an f64 round a numeric string.
fn decimal(text: &str) -> Option<(bool, String, i64)> {
    let text = text.trim();
    let negative = text.starts_with('-');
    let text = text.strip_prefix('-').unwrap_or(text);
    let (mantissa, exponent) = text.split_once(['e', 'E']).unwrap_or((text, "0"));
    let exponent: i64 = exponent.parse().ok()?;
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits = format!("{whole}{fraction}")
        .trim_start_matches('0')
        .to_owned();
    if digits.is_empty() {
        return Some((negative, "0".into(), 0));
    }
    let trailing = digits.len() - digits.trim_end_matches('0').len();
    digits.truncate(digits.len() - trailing);
    let power = exponent
        .checked_sub(i64::try_from(fraction.len()).ok()?)?
        .checked_add(i64::try_from(trailing).ok()?)?;
    Some((negative, digits, power))
}
