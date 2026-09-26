//! Keep an oversized artifact page's delivered prefix and cursor consistent.

use serde_json::Value;

use crate::btcc::BtccError;
use crate::json::{raw_string_units, visit_raw_object};

use super::super::{failure, field};

struct Stream<'a> {
    name: &'static str,
    slice: &'a str,
    text: &'a str,
    units: usize,
}

pub(in crate::host::guided_tools::message::preview) fn fit(
    payload: &str,
    max_bytes: usize,
) -> Result<String, BtccError> {
    if payload.len() <= max_bytes {
        return Ok(payload.into());
    }
    let Some(output) = field(payload, "output")?.filter(|raw| object(raw)) else {
        return Ok(payload.into());
    };
    let mut streams = Vec::with_capacity(3);
    for key in ["stdout", "stderr", "text"] {
        if let Some(raw) = field(output, key)?.filter(|raw| object(raw))
            && let Some(text) = field(raw, "text")?.filter(|raw| string_raw(raw))
        {
            streams.push(Stream {
                name: key,
                slice: raw,
                text,
                units: raw_string_units(text).count(),
            });
        }
    }
    if streams.is_empty() {
        return Ok(payload.into());
    }
    let longest = streams.iter().map(|stream| stream.units).max().unwrap_or(0);
    let mut low = 0usize;
    // A visible code unit needs at least one encoded byte. Larger candidates
    // cannot fit, so avoid copying a huge artifact page during binary search.
    let mut high = longest.min(max_bytes);
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        let candidate = page(payload, output, &streams, middle)?;
        if candidate.len() <= max_bytes {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    if low == 0 {
        Ok(payload.into())
    } else {
        page(payload, output, &streams, low)
    }
}

fn page(
    payload: &str,
    output: &str,
    streams: &[Stream<'_>],
    limit: usize,
) -> Result<String, BtccError> {
    let clipped = streams
        .iter()
        .filter(|stream| stream.units > limit)
        .map(|stream| {
            Ok((
                stream.name,
                clipped_slice(stream.slice, stream.text, limit)?,
            ))
        })
        .collect::<Result<Vec<_>, BtccError>>()?;
    let projected_output = replace(output, &clipped)?;
    replace(
        payload,
        &[
            ("output", projected_output),
            (
                "model_preview",
                String::from("{\"truncated\":true,\"completeness\":\"partial\"}"),
            ),
        ],
    )
}

fn clipped_slice(raw: &str, text: &str, limit: usize) -> Result<String, BtccError> {
    let visible = raw_string_units(text).take(limit).collect::<Vec<_>>();
    let content = units_literal(&visible);
    let start = match field(raw, "start_char")? {
        None | Some("null") => 0.0,
        Some(value) => {
            let parsed: Value = serde_json::from_str(value).map_err(|_| failure())?;
            crate::json::coerce_number(&parsed).map_err(|_| failure())?
        }
    };
    let next = start + visible.len() as f64;
    let next = if let Some(number) = serde_json::Number::from_f64(next) {
        crate::json::stringify(&Value::Number(number)).map_err(|_| failure())?
    } else {
        "null".into()
    };
    let lines = if visible.is_empty() {
        0
    } else {
        visible.iter().filter(|unit| **unit == 10).count()
            + usize::from(visible.last() != Some(&10))
    };
    replace(
        raw,
        &[
            ("text", content),
            ("next_offset_chars", next),
            ("returned_lines", lines.to_string()),
            ("truncated_by_tokens", "true".into()),
        ],
    )
}

fn replace(raw: &str, fields: &[(&str, String)]) -> Result<String, BtccError> {
    let mut output = String::from("{");
    let mut seen = vec![false; fields.len()];
    visit_raw_object(raw, |key, value| {
        let decoded: String = serde_json::from_str(key).map_err(crate::json::JsonError::from)?;
        if output.len() > 1 {
            output.push(',');
        }
        output.push_str(key);
        output.push(':');
        if let Some((index, (_, replacement))) = fields
            .iter()
            .enumerate()
            .find(|(_, (name, _))| *name == decoded.as_str())
        {
            seen[index] = true;
            output.push_str(replacement);
        } else {
            output.push_str(value);
        }
        Ok(())
    })
    .map_err(|_| failure())?;
    for (index, (key, value)) in fields.iter().enumerate() {
        if !seen[index] {
            if output.len() > 1 {
                output.push(',');
            }
            crate::json::write_string(key, &mut output).map_err(|_| failure())?;
            output.push(':');
            output.push_str(value);
        }
    }
    output.push('}');
    Ok(output)
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

fn object(raw: &str) -> bool {
    raw.trim_start().starts_with('{')
}
fn string_raw(raw: &str) -> bool {
    raw.trim_start().starts_with('"')
}
