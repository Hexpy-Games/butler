//! Select public semantic facts from a result's at-most-four nested layers.

use std::collections::VecDeque;

use crate::btcc::BtccError;
use crate::json::{raw_string_units, visit_raw_object};

use super::{encode, json_error, value, write_string};

pub(super) fn facts(
    result: Option<&crate::json::JsonDocument>,
    error_code: Option<&str>,
) -> Result<String, BtccError> {
    let mut error = None;
    let mut effect_status = None;
    let mut effect_receipt = None;
    let mut current = result.map(|result| result.as_str());
    for _ in 0..4 {
        let Some(layer) = current.filter(|raw| raw.trim_start().starts_with('{')) else {
            break;
        };
        let layer_error = field(layer, "error")?;
        let error_object = layer_error.filter(|raw| raw.trim_start().starts_with('{'));
        if error.is_none()
            && (error_object.is_some()
                || layer_error
                    .and_then(|raw| semantic_string(raw, 1_200))
                    .is_some())
        {
            let mut selected = String::from("{");
            let selected_code = error_object
                .map(|raw| field(raw, "code"))
                .transpose()?
                .flatten()
                .filter(|raw| *raw != "null")
                .or(field(layer, "code")?.filter(|raw| *raw != "null"));
            let code = match selected_code {
                Some(raw) => semantic_string(raw, 160),
                None => error_code
                    .filter(|code| !code.is_empty())
                    .and_then(|code| semantic_string(&string(code), 160)),
            };
            append(&mut selected, "code", code.as_deref())?;
            let message = error_object
                .map(|raw| field(raw, "message"))
                .transpose()?
                .flatten()
                .and_then(|raw| semantic_string(raw, 1_200))
                .or_else(|| layer_error.and_then(|raw| semantic_string(raw, 1_200)));
            append(&mut selected, "message", message.as_deref())?;
            let recoverable = error_object
                .map(|raw| field(raw, "recoverable"))
                .transpose()?
                .flatten()
                .and_then(boolean)
                .or(field(layer, "recoverable")?.and_then(boolean));
            append(&mut selected, "recoverable", recoverable)?;
            let next_action = error_object
                .map(|raw| field(raw, "next_action"))
                .transpose()?
                .flatten()
                .filter(|raw| *raw != "null")
                .or(field(layer, "next_action")?);
            let next_action = next_action.map(semantic_value).transpose()?.flatten();
            append(&mut selected, "next_action", next_action.as_deref())?;
            selected.push('}');
            error = Some(selected);
        }
        if effect_status.is_none() {
            let nested = error_object
                .map(|raw| field(raw, "effect_status"))
                .transpose()?
                .flatten()
                .and_then(|raw| semantic_string(raw, 120));
            effect_status =
                nested.or(field(layer, "effect_status")?.and_then(|raw| semantic_string(raw, 120)));
        }
        if effect_receipt.is_none() {
            effect_receipt = field(layer, "effect_receipt")?
                .filter(|raw| raw.trim_start().starts_with('{'))
                .map(receipt)
                .transpose()?;
        }
        current = field(layer, "result")?
            .filter(|raw| raw.trim_start().starts_with('{'))
            .or(field(layer, "output")?.filter(|raw| raw.trim_start().starts_with('{')));
    }
    if error.is_none()
        && let Some(code) = error_code.filter(|code| !code.is_empty())
        && let Some(code) = semantic_string(&string(code), 160)
    {
        error = Some(format!("{{\"code\":{code}}}"));
    }
    if effect_status.is_none() && effect_receipt.is_some() {
        effect_status = Some("\"applied\"".into());
    }
    let mut output = String::new();
    append(&mut output, "error", error.as_deref())?;
    append(&mut output, "effect_status", effect_status.as_deref())?;
    append(&mut output, "effect_receipt", effect_receipt.as_deref())?;
    Ok(output)
}

fn receipt(raw: &str) -> Result<String, BtccError> {
    let mut output = String::from("{");
    for (key, max) in [("capability", 160), ("target", 800), ("applied_at", 80)] {
        let selected = field(raw, key)?.and_then(|value| semantic_string(value, max));
        append(&mut output, key, selected.as_deref())?;
    }
    append(
        &mut output,
        "replayed",
        field(raw, "replayed")?.and_then(boolean),
    )?;
    output.push('}');
    Ok(output)
}

fn semantic_value(raw: &str) -> Result<Option<String>, BtccError> {
    if raw.trim_start().starts_with('"') {
        return Ok(semantic_string(raw, 800));
    }
    let parsed = serde_json::from_str(raw)
        .map_err(|error| BtccError::new("guided_prompt_json_invalid", error.to_string()))?;
    encode(&value::project(parsed, 0, "")?).map(Some)
}

fn field<'a>(raw: &'a str, name: &str) -> Result<Option<&'a str>, BtccError> {
    if !raw.trim_start().starts_with('{') {
        return Ok(None);
    }
    let mut selected = None;
    visit_raw_object(raw, |key, value| {
        if serde_json::from_str::<String>(key).ok().as_deref() == Some(name) {
            selected = Some(value);
        }
        Ok(())
    })
    .map_err(json_error)?;
    Ok(selected)
}

fn boolean(raw: &str) -> Option<&str> {
    matches!(raw.trim(), "true" | "false").then_some(raw)
}

fn append(output: &mut String, name: &str, raw: Option<&str>) -> Result<(), BtccError> {
    if let Some(raw) = raw {
        if !output.is_empty() && output != "{" {
            output.push(',');
        }
        write_string(name, output)?;
        output.push(':');
        output.push_str(raw);
    }
    Ok(())
}

fn string(value: &str) -> String {
    let mut output = String::new();
    crate::json::write_string(value, &mut output).expect("writing to String");
    output
}

/// Source String.length/slice units, retaining unpaired surrogate escapes.
fn semantic_string(raw: &str, max_chars: usize) -> Option<String> {
    if !raw.trim_start().starts_with('"') {
        return None;
    }
    let mut total = 0usize;
    let mut head = Vec::with_capacity(max_chars);
    let mut tail = VecDeque::with_capacity(max_chars);
    for unit in raw_string_units(raw) {
        total += 1;
        if head.len() < max_chars {
            head.push(unit);
        }
        if tail.len() == max_chars {
            tail.pop_front();
        }
        tail.push_back(unit);
    }
    if total == 0 {
        return None;
    }
    if total <= max_chars {
        return Some(units_literal(&head));
    }
    let marker = format!("\n...[{} chars omitted]...\n", total - max_chars);
    let available = max_chars.saturating_sub(marker.encode_utf16().count());
    let front = available.div_ceil(2);
    let back = available / 2;
    let mut selected = Vec::with_capacity(front + marker.len() + back);
    selected.extend_from_slice(&head[..front.min(head.len())]);
    selected.extend(marker.encode_utf16());
    selected.extend(tail.iter().skip(tail.len().saturating_sub(back)).copied());
    Some(units_literal(&selected))
}

fn units_literal(units: &[u16]) -> String {
    let mut output = String::from("\"");
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => output.push_str("\\\""),
            Ok('\\') => output.push_str("\\\\"),
            Ok('\u{0008}') => output.push_str("\\b"),
            Ok('\u{000c}') => output.push_str("\\f"),
            Ok('\n') => output.push_str("\\n"),
            Ok('\r') => output.push_str("\\r"),
            Ok('\t') => output.push_str("\\t"),
            Ok(value) if value < ' ' => output.push_str(&format!("\\u{:04x}", value as u32)),
            Ok(value) => output.push(value),
            Err(error) => output.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
        }
    }
    output.push('"');
    output
}
