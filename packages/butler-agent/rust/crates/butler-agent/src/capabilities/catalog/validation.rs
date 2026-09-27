//! Source tool-call JSON-schema subset at the progressive dispatch boundary.

use serde_json::Value;

type Violation = (String, String);

pub(crate) fn validate_native_arguments(args: &Value, schema: &Value) -> Result<(), Violation> {
    if !schema.is_object() {
        return Ok(());
    }
    validate(args, schema, "$")
}

fn validate(value: &Value, schema: &Value, path: &str) -> Result<(), Violation> {
    let Some(rule) = schema.as_object() else {
        return Ok(());
    };
    if let Some(expected) = rule.get("const")
        && !primitive_equal(value, expected)
    {
        return Err((format!("Expected constant value at {path}"), path.into()));
    }
    if let Some(options) = rule.get("enum").and_then(Value::as_array)
        && !options.iter().any(|option| primitive_equal(value, option))
    {
        return Err((format!("Invalid enum value at {path}"), path.into()));
    }
    for (name, exclusive) in [("oneOf", true), ("anyOf", false)] {
        if let Some(variants) = rule.get(name).and_then(Value::as_array) {
            let results = variants
                .iter()
                .map(|variant| validate(value, variant, path))
                .collect::<Vec<_>>();
            let matched = results.iter().filter(|result| result.is_ok()).count();
            if matched == 0 {
                let (message, failed_path) = results
                    .into_iter()
                    .find_map(Result::err)
                    .unwrap_or_else(|| {
                        (format!("No schema variant matched at {path}"), path.into())
                    });
                return Err((format!("No schema variant matched: {message}"), failed_path));
            }
            if exclusive && matched != 1 {
                return Err((
                    format!("Expected exactly one schema variant at {path}"),
                    path.into(),
                ));
            }
        }
    }
    let types = rule.get("type").map_or_else(Vec::new, |kind| match kind {
        Value::String(name) => vec![name.as_str()],
        Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    });
    if !types.is_empty() && !types.iter().any(|kind| matches_type(value, kind)) {
        return Err((
            format!("Expected {} at {path}", types.join(" or ")),
            path.into(),
        ));
    }
    if let Some(items) = value.as_array() {
        if let Some(minimum) = rule.get("minItems").and_then(Value::as_f64)
            && (items.len() as f64) < minimum
        {
            return Err((
                format!("Expected at least {minimum} items at {path}"),
                path.into(),
            ));
        }
        if let Some(maximum) = rule.get("maxItems").and_then(Value::as_f64)
            && (items.len() as f64) > maximum
        {
            return Err((
                format!("Expected at most {maximum} items at {path}"),
                path.into(),
            ));
        }
        if let Some(item_rule) = rule.get("items") {
            for (index, item) in items.iter().enumerate() {
                validate(item, item_rule, &format!("{path}[{index}]"))?;
            }
        }
    } else if let Some(fields) = value.as_object() {
        if let Some(required) = rule.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !fields.contains_key(name) {
                    return Err((
                        format!("Missing required argument: {name}"),
                        format!("{path}.{name}"),
                    ));
                }
            }
        }
        let properties = rule.get("properties").and_then(Value::as_object);
        if let Some(properties) = properties {
            for (name, property_rule) in properties {
                if let Some(field) = fields.get(name) {
                    validate(field, property_rule, &format!("{path}.{name}"))?;
                }
            }
        }
        let unexpected = fields
            .keys()
            .filter(|name| properties.is_none_or(|rules| !rules.contains_key(*name)))
            .collect::<Vec<_>>();
        if rule.get("additionalProperties") == Some(&Value::Bool(false)) && !unexpected.is_empty() {
            let names = unexpected
                .iter()
                .map(|name| name.as_str())
                .collect::<Vec<_>>();
            let message = if names.len() == 1 {
                format!("Unexpected argument: {}", names[0])
            } else {
                format!("Unexpected arguments: {}", names.join(", "))
            };
            let failed_path = if names.len() == 1 {
                format!("{path}.{}", names[0])
            } else {
                path.into()
            };
            return Err((message, failed_path));
        }
        if let Some(extra_rule @ Value::Object(_)) = rule.get("additionalProperties") {
            for name in unexpected {
                validate(&fields[name], extra_rule, &format!("{path}.{name}"))?;
            }
        }
    } else if let Some(number) = value.as_f64() {
        if let Some(minimum) = rule.get("minimum").and_then(Value::as_f64)
            && number < minimum
        {
            return Err((
                format!("Expected value >= {minimum} at {path}"),
                path.into(),
            ));
        }
        if let Some(maximum) = rule.get("maximum").and_then(Value::as_f64)
            && number > maximum
        {
            return Err((
                format!("Expected value <= {maximum} at {path}"),
                path.into(),
            ));
        }
    } else if let Some(text) = value.as_str() {
        let length = text.encode_utf16().count() as f64;
        if let Some(minimum) = rule.get("minLength").and_then(Value::as_f64)
            && length < minimum
        {
            return Err((
                format!("Expected string length >= {minimum} at {path}"),
                path.into(),
            ));
        }
        if let Some(maximum) = rule.get("maxLength").and_then(Value::as_f64)
            && length > maximum
        {
            return Err((
                format!("Expected string length <= {maximum} at {path}"),
                path.into(),
            ));
        }
        if let Some(pattern) = rule.get("pattern").and_then(Value::as_str) {
            let matcher = regress::Regex::new(pattern)
                .map_err(|_| (format!("Invalid string pattern at {path}"), path.into()))?;
            let units = text.encode_utf16().collect::<Vec<_>>();
            if matcher.find_from_ucs2(&units, 0).next().is_none() {
                return Err((
                    format!("Expected string to match {pattern} at {path}"),
                    path.into(),
                ));
            }
        }
    }
    Ok(())
}

fn matches_type(value: &Value, kind: &str) -> bool {
    match kind {
        "array" => value.is_array(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        _ => false,
    }
}

fn primitive_equal(left: &Value, right: &Value) -> bool {
    if left.is_array() || left.is_object() || right.is_array() || right.is_object() {
        return false; // JavaScript strict equality does not equate distinct schema objects.
    }
    left == right
}
