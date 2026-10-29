//! Schema traversal adds references, aggregate feedback and RFC 3339 to native validation.

use chrono::DateTime;
use serde_json::Value;

use super::{AnswerBlocksProblem, pointer, push};
use crate::capabilities::catalog::validate_native_arguments;

pub(super) fn resolve<'a>(schema: &'a Value, root: &'a Value) -> &'a Value {
    schema
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|reference| reference.strip_prefix('#'))
        .and_then(|path| root.pointer(path))
        .unwrap_or(schema)
}

pub(super) fn validate(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    problems: &mut Vec<AnswerBlocksProblem>,
) {
    if problems.len() >= super::MAX_PROBLEMS {
        return;
    }
    let schema = resolve(schema, root);
    if let Some(variants) = schema.get("oneOf").and_then(Value::as_array) {
        variants_check(value, variants, root, path, problems);
        return;
    }
    let mut shallow = schema.clone();
    if let Some(rule) = shallow.as_object_mut() {
        for key in [
            "properties",
            "items",
            "required",
            "additionalProperties",
            "$defs",
            "minLength",
            "maxLength",
        ] {
            rule.remove(key);
        }
    }
    if let Err((fix, _)) = validate_native_arguments(value, &shallow) {
        push(
            problems,
            path,
            format!(
                "{fix}; use the declared type or value; split excess entries into another block or call"
            ),
        );
        return;
    }
    if let (Some(number), Some(min)) = (value.as_f64(), schema["exclusiveMinimum"].as_f64())
        && number <= min
    {
        push(problems, path, format!("use a number greater than {min}"));
    }
    if let Some(text) = value.as_str() {
        string_check(text, schema, path, problems);
    }
    if let Some(items) = value.as_array()
        && let Some(rule) = schema.get("items")
    {
        for (i, item) in items.iter().enumerate() {
            validate(item, rule, root, &pointer(path, &i.to_string()), problems);
        }
    }
    if value.is_object() {
        object_check(value, schema, root, path, problems);
    }
}

/// Resolve references before choosing by type, including the leaf union.
pub(super) fn variant<'a>(value: &Value, schema: &'a Value, root: &'a Value) -> Option<&'a Value> {
    let rule = resolve(schema, root);
    if let Some(variants) = rule["oneOf"].as_array() {
        return variants
            .iter()
            .find_map(|candidate| variant(value, candidate, root));
    }
    (rule.pointer("/properties/type/const") == value.get("type") && value.get("type").is_some())
        .then_some(rule)
}

fn variants_check(
    value: &Value,
    variants: &[Value],
    root: &Value,
    path: &str,
    problems: &mut Vec<AnswerBlocksProblem>,
) {
    if let Some(selected) = variants.iter().find_map(|rule| variant(value, rule, root)) {
        validate(value, selected, root, path, problems);
        return;
    }
    if matches!(value["type"].as_str(), Some("columns" | "tabs" | "group")) {
        push(
            problems,
            path,
            "containers never nest; move this container to the top level",
        );
        return;
    }
    let results: Vec<_> = variants
        .iter()
        .map(|variant| {
            let mut result = Vec::new();
            validate(value, variant, root, path, &mut result);
            (resolve(variant, root), result)
        })
        .collect();
    let matched = results
        .iter()
        .filter(|(_, errors)| errors.is_empty())
        .count();
    if matched == 1 {
        return;
    }
    if matched > 1 {
        push(problems, path, "use exactly one declared alternative");
        return;
    }
    // Prefer the declared discriminator, then the closest set of field names.
    let best = results.into_iter().min_by_key(|(variant, errors)| {
        let props = variant.get("properties").and_then(Value::as_object);
        let mismatch = props.is_some_and(|p| {
            p.iter().any(|(key, rule)| {
                rule.get("const")
                    .is_some_and(|expected| value.get(key) != Some(expected))
            })
        });
        let overlap = props.map_or(0, |p| {
            p.keys().filter(|key| value.get(*key).is_some()).count()
        });
        (mismatch, std::cmp::Reverse(overlap), errors.len())
    });
    if let Some((_, errors)) = best {
        for error in errors {
            push(problems, &error.path, error.fix);
        }
    }
}

fn object_check(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    problems: &mut Vec<AnswerBlocksProblem>,
) {
    let Some(fields) = value.as_object() else {
        return;
    };
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !fields.contains_key(key) {
                push(
                    problems,
                    &pointer(path, key),
                    format!("required field; supply {key}"),
                );
            }
        }
    }
    if let Some(forbidden) = schema
        .get("not")
        .and_then(|s| s.get("required"))
        .and_then(Value::as_array)
    {
        let keys: Vec<_> = forbidden.iter().filter_map(Value::as_str).collect();
        if keys.iter().all(|key| fields.contains_key(*key)) {
            push(
                problems,
                path,
                format!(
                    "{} are mutually exclusive; keep only one",
                    keys.join(" and ")
                ),
            );
        }
    }
    let Some(props) = schema.get("properties").and_then(Value::as_object) else {
        return;
    };
    for (key, field) in fields {
        if let Some(rule) = props.get(key) {
            validate(field, rule, root, &pointer(path, key), problems);
        } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            let hint = nearest(key, field, props, root);
            push(
                problems,
                &pointer(path, key),
                format!("unknown key {key:?}; {hint}"),
            );
        }
    }
}

fn string_check(text: &str, schema: &Value, path: &str, problems: &mut Vec<AnswerBlocksProblem>) {
    let length = text.chars().count() as u64;
    for (key, too_long) in [("minLength", false), ("maxLength", true)] {
        if let Some(limit) = schema.get(key).and_then(Value::as_u64)
            && if too_long {
                length > limit
            } else {
                length < limit
            }
        {
            push(
                problems,
                path,
                format!(
                    "use {} {limit} characters; move longer detail to reply text",
                    if too_long { "at most" } else { "at least" }
                ),
            );
        }
    }
    if schema.get("format").and_then(Value::as_str) == Some("date-time")
        && DateTime::parse_from_rfc3339(text).is_err()
    {
        push(
            problems,
            path,
            "use an RFC 3339 timestamp with seconds and a timezone offset",
        );
    }
    if schema.get("pattern").and_then(Value::as_str) == Some("^https?://") {
        let valid = url::Url::parse(text)
            .is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some());
        if !valid {
            push(problems, path, "use a complete http(s) URL with a host");
        }
    }
}

fn nearest(
    key: &str,
    value: &Value,
    props: &serde_json::Map<String, Value>,
    root: &Value,
) -> String {
    let shape = value.as_object().and_then(|fields| {
        props
            .iter()
            .find(|(_, rule)| {
                let rule = resolve(rule, root);
                rule.get("properties")
                    .and_then(Value::as_object)
                    .is_some_and(|p| fields.keys().all(|k| p.contains_key(k)))
            })
            .map(|(name, _)| name.as_str())
    });
    let name = shape.or_else(|| {
        props
            .keys()
            .min_by_key(|name| (!key.starts_with(name.as_str()), distance(key, name)))
            .map(String::as_str)
    });
    name.map_or_else(
        || "remove this key".into(),
        |name| format!("did you mean {name:?}? Use a declared key or remove it"),
    )
}

fn distance(left: &str, right: &str) -> usize {
    let right: Vec<_> = right.chars().collect();
    let mut row: Vec<_> = (0..=right.len()).collect();
    for (i, a) in left.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, b) in right.iter().enumerate() {
            let old = row[j + 1];
            row[j + 1] = (row[j] + 1)
                .min(old + 1)
                .min(previous + usize::from(a != *b));
            previous = old;
        }
    }
    row[right.len()]
}
