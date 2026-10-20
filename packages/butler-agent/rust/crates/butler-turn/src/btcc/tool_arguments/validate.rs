use super::example::{close, declared_type, kind, preview, unexpected};
use serde_json::{Map, Value};

type Violation = (String, String);

pub fn validate_native_arguments(args: &Value, schema: &Value) -> Result<(), Violation> {
    validate(args, schema, "$", "", true)
}

pub(super) fn validate(
    value: &Value,
    schema: &Value,
    path: &str,
    tool: &str,
    strict: bool,
) -> Result<(), Violation> {
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
        return Err((
            format!(
                "\"{path}\" must be one of {}, not {}",
                Value::Array(options.clone()),
                preview(value)
            ),
            path.into(),
        ));
    }
    variants(value, schema, path, tool, strict)?;
    let types = rule.get("type").map_or_else(Vec::new, |kind| match kind {
        Value::String(name) => vec![name.as_str()],
        Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    });
    if !types.is_empty() && !types.iter().any(|kind| matches_type(value, kind)) {
        return Err((
            format!(
                "\"{path}\" must be {}, not {} {}",
                types.join(" or "),
                kind(value),
                preview(value)
            ),
            path.into(),
        ));
    }
    if let Some(items) = value.as_array() {
        array(items, schema, path, tool, strict)?;
    } else if let Some(fields) = value.as_object() {
        object(fields, schema, path, tool, strict)?;
    } else if let Some(number) = value.as_f64() {
        for (key, op, bad) in [("minimum", ">=", true), ("maximum", "<=", false)] {
            if let Some(bound) = schema.get(key).and_then(Value::as_f64)
                && (if bad { number < bound } else { number > bound })
            {
                return Err((format!("\"{path}\" must be {op} {bound}"), path.into()));
            }
        }
    } else if let Some(text) = value.as_str() {
        string(text, schema, path)?;
    }
    Ok(())
}

fn variants(
    value: &Value,
    schema: &Value,
    path: &str,
    tool: &str,
    strict: bool,
) -> Result<(), Violation> {
    for (name, exclusive) in [("oneOf", true), ("anyOf", false)] {
        if let Some(variants) = schema.get(name).and_then(Value::as_array) {
            let results: Vec<_> = variants
                .iter()
                .map(|rule| validate(value, rule, path, tool, strict))
                .collect();
            let matched = results.iter().filter(|r| r.is_ok()).count();
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
    Ok(())
}

fn object(
    fields: &Map<String, Value>,
    schema: &Value,
    path: &str,
    tool: &str,
    strict: bool,
) -> Result<(), Violation> {
    let properties = schema.get("properties").and_then(Value::as_object);
    required_fields(fields, schema, path, tool)?;
    if let Some(properties) = properties {
        for (name, rule) in properties {
            if let Some(value) = fields.get(name) {
                validate(value, rule, &child(path, name), tool, strict)?;
            }
        }
    }
    if !strict {
        return Ok(());
    }
    for (name, value) in fields
        .iter()
        .filter(|(name, _)| properties.is_none_or(|p| !p.contains_key(*name)))
    {
        match schema.get("additionalProperties") {
            Some(Value::Bool(false)) => {
                return Err((unexpected(tool, name, properties), child(path, name)));
            }
            Some(rule @ Value::Object(_)) => {
                validate(value, rule, &child(path, name), tool, strict)?;
            }
            _ => (),
        }
    }
    Ok(())
}

fn child(path: &str, name: &str) -> String {
    if path == "$" {
        name.into()
    } else {
        format!("{path}.{name}")
    }
}

fn array(
    items: &[Value],
    schema: &Value,
    path: &str,
    tool: &str,
    strict: bool,
) -> Result<(), Violation> {
    let min = schema.get("minItems").and_then(Value::as_u64);
    let max = schema.get("maxItems").and_then(Value::as_u64);
    let length = u64::try_from(items.len()).unwrap_or(u64::MAX);
    if min.is_some_and(|n| length < n) || max.is_some_and(|n| length > n) {
        let problem = if min == max {
            format!("\"{path}\" must have exactly {} items", min.unwrap_or(0))
        } else {
            let minimum = min.map(|n| n.to_string()).unwrap_or_else(|| "0".into());
            let maximum = max.map(|n| n.to_string()).unwrap_or_else(|| "∞".into());
            format!("\"{path}\" must have {minimum}-{maximum} items")
        };
        return Err((problem, path.into()));
    }
    if let Some(rule) = schema.get("items") {
        for (index, item) in items.iter().enumerate() {
            validate(item, rule, &format!("{path}[{index}]"), tool, strict)?;
        }
    }
    Ok(())
}

fn string(text: &str, schema: &Value, path: &str) -> Result<(), Violation> {
    let length = text.encode_utf16().count() as f64;
    if let Some(minimum) = schema.get("minLength").and_then(Value::as_f64)
        && length < minimum
    {
        return Err((
            format!("Expected string length >= {minimum} at {path}"),
            path.into(),
        ));
    }
    if let Some(maximum) = schema.get("maxLength").and_then(Value::as_f64)
        && length > maximum
    {
        return Err((
            format!("Expected string length <= {maximum} at {path}"),
            path.into(),
        ));
    }
    if let Some(pattern) = schema.get("pattern").and_then(Value::as_str) {
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
    !left.is_array()
        && !left.is_object()
        && !right.is_array()
        && !right.is_object()
        && left == right
}

fn required_fields(
    fields: &Map<String, Value>,
    schema: &Value,
    path: &str,
    tool: &str,
) -> Result<(), Violation> {
    let properties = schema.get("properties").and_then(Value::as_object);
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for name in required.iter().filter_map(Value::as_str) {
            if !fields.contains_key(name) {
                let kind = properties
                    .and_then(|p| p.get(name))
                    .map(declared_type)
                    .unwrap_or_else(|| "object".into());
                let mut problem = format!("required argument \"{name}\" ({kind}) is missing");
                if let Some(properties) = properties {
                    for unknown in fields.keys().filter(|key| !properties.contains_key(*key)) {
                        if close(unknown, properties) == Some(name) {
                            problem.push_str(&format!(
                                ". {}",
                                unexpected(tool, unknown, Some(properties))
                            ));
                        }
                    }
                }
                return Err((problem, child(path, name)));
            }
        }
    }
    Ok(())
}
