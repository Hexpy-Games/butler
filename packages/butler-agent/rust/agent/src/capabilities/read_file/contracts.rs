use serde_json::{Value, json};

use super::super::CapabilityError;

const DEFAULT_MAX_BYTES: usize = 65_536;

#[derive(Clone, Debug)]
pub(super) struct Request {
    pub(super) path: String,
    pub(super) start_line: Option<usize>,
    pub(super) limit_lines: Option<usize>,
    pub(super) max_bytes: usize,
}

pub(crate) fn definition() -> Value {
    json!({
      "type": "function", "name": "read_file",
      "description": "Read 1-20 bounded UTF-8 workspace files in request order with path guard, binary/UTF-8 checks, aggregate limits, stale-safe continuation, and evidence receipts. Use a one-item requests array for one file.",
      "parameters": { "type": "object", "additionalProperties": false, "properties": {
        "requests": { "type": "array", "minItems": 1, "maxItems": 20, "description": "Canonical bounded read requests. Use one item for one file.",
          "items": { "type": "object", "additionalProperties": false, "properties": {
            "path": { "type": "string", "description": "File path inside the active workspace. Prefer a workspace-relative path; a contained absolute path shown by a tool is also accepted." },
            "start_line": { "type": "integer", "minimum": 1 },
            "limit_lines": { "type": "integer", "minimum": 1, "maximum": 10000, "description": "Total requested line range, including cursor continuations. Later file lines are outside this request." },
            "max_bytes": { "type": "integer", "minimum": 1, "maximum": 1_048_576 }
          }, "required": ["path"] }
        },
        "max_total_bytes": { "type": "integer", "minimum": 1, "maximum": 4_194_304 }, "cursor": { "type": "string" }
      }, "required": ["requests"] },
      "effectBoundary": "none", "concurrencySafe": true, "interruptBehavior": "continue", "transcriptVisibility": "visible"
    })
}

pub(super) fn normalize_request(value: &Value) -> Result<Option<Request>, CapabilityError> {
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    let Some(path) = object
        .get("path")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
    else {
        return Ok(None);
    };
    if path.is_empty() {
        return Ok(None);
    }
    Ok(Some(Request {
        path: path.into(),
        start_line: object
            .get("start_line")
            .map(|v| integer(Some(v), 1, 1, 10_000_000))
            .transpose()?,
        limit_lines: object
            .get("limit_lines")
            .map(|v| integer(Some(v), 1, 1, 10_000))
            .transpose()?,
        max_bytes: integer(object.get("max_bytes"), DEFAULT_MAX_BYTES, 1, 1_048_576)?,
    }))
}
impl Request {
    pub(super) fn query_value(&self) -> Value {
        let mut object = json!({ "path": self.path, "max_bytes": self.max_bytes });
        if let Some(value) = self.start_line {
            object["start_line"] = json!(value);
        }
        if let Some(value) = self.limit_lines {
            object["limit_lines"] = json!(value);
        }
        object
    }
}
pub(super) fn integer(
    value: Option<&Value>,
    fallback: usize,
    min: usize,
    max: usize,
) -> Result<usize, CapabilityError> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let number = crate::json::coerce_number(value).map_err(|_| CapabilityError {
        code: "invalid_number_conversion".into(),
    })?;
    if !number.is_finite() {
        return Ok(fallback);
    }
    Ok(crate::json::saturating_usize(
        number.floor().max(min as f64).min(max as f64),
    ))
}
pub(super) fn parse_args(call: &Value) -> Result<Value, (&'static str, String)> {
    let object = call.as_object().ok_or((
        "invalid_arguments_shape",
        "Tool arguments must be an object or JSON object string.".into(),
    ))?;
    let raw = ["arguments", "input", "args"]
        .into_iter()
        .find_map(|name| object.get(name).filter(|value| !value.is_null()))
        .cloned()
        .unwrap_or_else(|| json!({}));
    match raw {
        Value::String(string) => match serde_json::from_str::<Value>(&string) {
            Ok(value) if value.is_object() => Ok(value),
            Ok(_) => Err((
                "invalid_arguments_shape",
                "Tool arguments JSON must decode to an object.".into(),
            )),
            Err(error) => Err(("invalid_arguments_json", error.to_string())),
        },
        Value::Object(_) => Ok(raw),
        _ => Err((
            "invalid_arguments_shape",
            "Tool arguments must be an object or JSON object string.".into(),
        )),
    }
}
