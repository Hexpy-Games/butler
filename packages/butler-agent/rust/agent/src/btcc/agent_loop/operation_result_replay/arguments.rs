use serde_json::{Map, Value};

use crate::btcc::BtccError;

use super::contracts::{ExactReadArguments, ExactReadSource};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
pub(super) const MAX_EXACT_READ_BYTES: usize = 4096;

pub(super) fn exact_read_arguments(
    value: &Map<String, Value>,
) -> Result<ExactReadArguments, BtccError> {
    let source = match value.get("source") {
        None => ExactReadSource::Result,
        Some(Value::String(value)) if value == "request" => ExactReadSource::Request,
        Some(Value::String(value)) if value == "result" => ExactReadSource::Result,
        _ => return Err(error("operation_result_source_invalid")),
    };
    let result_ref = value
        .get("result_ref")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or_default();
    if result_ref.is_empty() || utf16_len(result_ref) > 256 {
        return Err(error("operation_result_reference_invalid"));
    }
    let sha256 = value
        .get("sha256")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or_default();
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(error("operation_result_hash_invalid"));
    }
    let revision =
        nullable_safe_integer(value.get("revision"), "operation_result_revision_invalid")?;
    let work_id = match value.get("work_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(original)) => {
            let trimmed = crate::public_text::trim_js_whitespace(original);
            if trimmed.is_empty() || utf16_len(original) > 256 {
                return Err(error("operation_result_work_id_invalid"));
            }
            Some(trimmed.to_owned())
        }
        _ => return Err(error("operation_result_work_id_invalid")),
    };
    let offset = safe_integer(value.get("offset"), "operation_result_offset_invalid")?;
    let length = safe_integer(value.get("length"), "operation_result_length_invalid")?;
    if length == 0 || length > MAX_EXACT_READ_BYTES {
        return Err(error("operation_result_length_invalid"));
    }
    Ok(ExactReadArguments {
        source,
        result_ref: result_ref.to_owned(),
        sha256: sha256.to_owned(),
        revision,
        work_id,
        offset,
        length,
    })
}

fn nullable_safe_integer(
    value: Option<&Value>,
    code: &'static str,
) -> Result<Option<f64>, BtccError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => number(value, code).map(Some),
    }
}

pub(super) fn safe_integer(value: Option<&Value>, code: &'static str) -> Result<usize, BtccError> {
    let number = value
        .ok_or_else(|| error(code))
        .and_then(|value| number(value, code))?;
    usize::try_from(number as u64).map_err(|_| error(code))
}

fn number(value: &Value, code: &'static str) -> Result<f64, BtccError> {
    let number = value.as_f64().ok_or_else(|| error(code))?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 || number > MAX_SAFE_INTEGER {
        return Err(error(code));
    }
    Ok(number)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(super) fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}
