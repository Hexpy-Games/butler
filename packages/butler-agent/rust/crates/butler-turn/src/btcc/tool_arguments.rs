//! Schema-driven representation repair and validation shared by tool dispatch paths.
mod example;
mod normalize;
mod validate;

pub use normalize::decode_object;
use serde_json::{Map, Value};
pub use validate::validate_native_arguments;

pub fn normalize_then_validate(
    tool: &str,
    schema: &Value,
    args: &Value,
) -> Result<Map<String, Value>, (String, String)> {
    normalize_and_validate(tool, schema, args, true)
}

/// Direct calls tolerate extra keys; missing required fields still get typo hints.
pub fn normalize_direct_arguments(
    tool: &str,
    schema: &Value,
    args: &Value,
) -> Result<Map<String, Value>, (String, String)> {
    normalize_and_validate(tool, schema, args, false)
}

fn normalize_and_validate(
    tool: &str,
    schema: &Value,
    args: &Value,
    strict: bool,
) -> Result<Map<String, Value>, (String, String)> {
    let value = normalize::arguments(tool, schema, args, strict);
    let result = if value.is_object() {
        validate::validate(&value, schema, "$", tool, strict)
    } else {
        Err(("arguments must be one JSON object".into(), "$".into()))
    };
    result.map_err(|(problem, field)| (corrective_message(tool, schema, &problem), field))?;
    Ok(value.as_object().cloned().unwrap_or_default())
}

fn corrective_message(tool: &str, schema: &Value, problem: &str) -> String {
    let example = example::example(schema, "");
    let params = example::parameters(schema);
    format!(
        "{tool} was not run: {problem}. Call {tool} again with arguments shaped like {example}. Its arguments: {params}."
    )
}
