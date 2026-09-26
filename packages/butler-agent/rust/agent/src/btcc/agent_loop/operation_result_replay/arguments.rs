use serde_json::{Map, Value};

use crate::btcc::BtccError;

use super::contracts::{ExactReadArguments, ExactReadSource};
use crate::btcc::BtccCode;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
pub(super) const MAX_EXACT_READ_BYTES: usize = 4096;

pub(super) fn exact_read_arguments(
    value: &Map<String, Value>,
) -> Result<ExactReadArguments, BtccError> {
    let source = match value.get("source") {
        None => ExactReadSource::Result,
        Some(Value::String(value)) if value == "request" => ExactReadSource::Request,
        Some(Value::String(value)) if value == "result" => ExactReadSource::Result,
        _ => return Err(error(BtccCode::OperationResultSourceInvalid)),
    };
    let result_ref = value
        .get("result_ref")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or_default();
    if result_ref.is_empty() || utf16_len(result_ref) > 256 {
        return Err(error(BtccCode::OperationResultReferenceInvalid));
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
        return Err(error(BtccCode::OperationResultHashInvalid));
    }
    let revision = nullable_safe_integer(
        value.get("revision"),
        BtccCode::OperationResultRevisionInvalid,
    )?;
    let work_id = match value.get("work_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(original)) => {
            let trimmed = crate::public_text::trim_js_whitespace(original);
            if trimmed.is_empty() || utf16_len(original) > 256 {
                return Err(error(BtccCode::OperationResultWorkIdInvalid));
            }
            Some(trimmed.to_owned())
        }
        _ => return Err(error(BtccCode::OperationResultWorkIdInvalid)),
    };
    let offset = safe_integer(value.get("offset"), BtccCode::OperationResultOffsetInvalid)?;
    let length = safe_integer(value.get("length"), BtccCode::OperationResultLengthInvalid)?;
    if length == 0 || length > MAX_EXACT_READ_BYTES {
        return Err(error(BtccCode::OperationResultLengthInvalid));
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

fn nullable_safe_integer(value: Option<&Value>, code: BtccCode) -> Result<Option<f64>, BtccError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => number(value, code).map(Some),
    }
}

pub(super) fn safe_integer(value: Option<&Value>, code: BtccCode) -> Result<usize, BtccError> {
    let number = value
        .ok_or_else(|| error(code))
        .and_then(|value| number(value, code))?;
    usize::try_from(crate::json::saturating_u64(number))
        .map_err(|source| error(code).with_source(source))
}

fn number(value: &Value, code: BtccCode) -> Result<f64, BtccError> {
    let number = value.as_f64().ok_or_else(|| error(code))?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 || number > MAX_SAFE_INTEGER {
        return Err(error(code));
    }
    Ok(number)
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(super) fn error(code: BtccCode) -> BtccError {
    BtccError::detected(code, code.as_str())
}
