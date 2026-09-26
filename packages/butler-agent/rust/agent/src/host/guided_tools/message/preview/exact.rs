//! Exact-result base64 page shrink keeps the delivered byte cursor honest.

use std::borrow::Cow;

use base64::Engine;

use crate::btcc::BtccError;

use super::{append_field, field};

pub(super) fn project_raw(raw: &str) -> Result<String, BtccError> {
    let mut selected = String::from("{\"tool_name\":\"read_operation_results\"");
    for key in [
        "encoding",
        "data",
        "offset",
        "length",
        "totalBytes",
        "nextOffset",
        "resultSha256",
        "complete",
    ] {
        let valid = |value: &str| match key {
            "encoding" | "data" | "resultSha256" => value.trim().starts_with('"'),
            "offset" | "length" | "totalBytes" => number_raw(value),
            "nextOffset" => value == "null" || number_raw(value),
            "complete" => value == "true" || value == "false",
            _ => false,
        };
        if let Some(value) = field(raw, key)?.filter(|raw| valid(raw)) {
            append_field(&mut selected, key, value)?;
        }
    }
    selected.push('}');
    Ok(selected)
}

pub(super) fn fit(payload: &str, max_bytes: usize) -> Result<String, BtccError> {
    if payload.len() <= max_bytes {
        return Ok(payload.into());
    }
    let Some(output) = field(payload, "output")? else {
        return Ok(payload.into());
    };
    let Some(raw_data) = field(output, "data")?.filter(|raw| raw.trim().starts_with('"')) else {
        return Ok(payload.into());
    };
    let data = if raw_data[1..raw_data.len() - 1].contains('\\') {
        Cow::Owned(serde_json::from_str::<String>(raw_data).map_err(|_| failure())?)
    } else {
        Cow::Borrowed(&raw_data[1..raw_data.len() - 1])
    };
    if data.is_empty() {
        return Ok(payload.into());
    }
    let Some(offset) =
        field(output, "offset")?.and_then(|raw| serde_json::from_str::<u64>(raw).ok())
    else {
        return Ok(payload.into());
    };
    let mut low = 0;
    let mut high = data.len() / 4;
    while low < high {
        let middle = (low + high).div_ceil(2);
        let candidate = page(payload, output, &data[..middle * 4], offset)?;
        if candidate.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    if low == 0 {
        Ok(payload.into())
    } else {
        page(payload, output, &data[..low * 4], offset)
    }
}

fn page(payload: &str, output: &str, data: &str, offset: u64) -> Result<String, BtccError> {
    let visible = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| {
            BtccError::new(
                "guided_tool_result_base64_invalid",
                "Exact result page is invalid",
            )
        })?
        .len();
    let mut body = String::from("{");
    if let Some(ok) = field(payload, "ok")? {
        body.push_str("\"ok\":");
        body.push_str(ok);
    }
    let mut projected = String::from("{");
    for key in ["tool_name", "encoding"] {
        if let Some(raw) = field(output, key)? {
            if projected.len() > 1 {
                projected.push(',');
            }
            crate::json::write_string(key, &mut projected).map_err(|_| failure())?;
            projected.push(':');
            projected.push_str(raw);
        }
    }
    if projected.len() > 1 {
        projected.push(',');
    }
    projected.push_str("\"data\":");
    crate::json::write_string(data, &mut projected).map_err(|_| failure())?;
    if let Some(raw) = field(output, "offset")? {
        append_field(&mut projected, "offset", raw)?;
    }
    projected.push_str(",\"length\":");
    projected.push_str(&visible.to_string());
    if let Some(length) = field(output, "length")? {
        append_field(&mut projected, "requested_length", length)?;
    }
    if let Some(raw) = field(output, "totalBytes")? {
        append_field(&mut projected, "totalBytes", raw)?;
    }
    projected.push_str(",\"nextOffset\":");
    projected.push_str(&offset.saturating_add(visible as u64).to_string());
    if let Some(raw) = field(output, "resultSha256")? {
        append_field(&mut projected, "resultSha256", raw)?;
    }
    projected.push_str(",\"complete\":false}");
    if body.len() > 1 {
        body.push(',');
    }
    body.push_str("\"output\":");
    body.push_str(&projected);
    body.push_str(",\"model_preview\":{");
    body.push_str("\"truncated\":true,\"completeness\":\"partial\",\"original_provider_bytes\":");
    body.push_str(&payload.len().to_string());
    body.push_str("}}");
    Ok(body)
}

fn number_raw(raw: &str) -> bool {
    raw.as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_digit() || *byte == b'-')
}
fn failure() -> BtccError {
    BtccError::new(
        "guided_tool_provider_serialization_failed",
        "Provider result JSON unavailable",
    )
}
