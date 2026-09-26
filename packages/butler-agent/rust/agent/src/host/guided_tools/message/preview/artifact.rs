//! Public artifact identity and delivered page facts, without full result DOMs.

mod page;
pub(super) use page::fit;

use crate::btcc::BtccError;
use crate::json::Utf16Prefix;

use super::{append_field, failure, field};

pub(super) fn project(name: &str, raw: &str) -> Result<String, BtccError> {
    let mut output = String::from("{\"tool_name\":");
    crate::json::write_string(name, &mut output).map_err(|_| failure())?;
    selected(
        &mut output,
        "ok",
        field(raw, "ok")?.filter(|raw| boolean(raw)),
    )?;
    if let Some(artifact) = field(raw, "artifact")?.filter(|raw| object(raw)) {
        append_field(&mut output, "artifact", &identity(artifact)?)?;
    }
    for key in if name == "read_tool_output_artifact" {
        &["stdout", "stderr"][..]
    } else {
        &["text"][..]
    } {
        if let Some(page) = field(raw, key)?.filter(|raw| object(raw)) {
            append_field(&mut output, key, &slice(page)?)?;
        }
    }
    let error = field(raw, "error")?
        .map(|raw| text(raw, Some(320)))
        .transpose()?
        .flatten();
    selected(&mut output, "error", error.as_deref())?;
    output.push('}');
    Ok(output)
}

fn identity(raw: &str) -> Result<String, BtccError> {
    let mut output = String::from("{");
    for key in ["id", "path", "tool_name"] {
        let value = field(raw, key)?
            .map(|raw| text(raw, None))
            .transpose()?
            .flatten();
        selected(&mut output, key, value.as_deref())?;
    }
    let command = field(raw, "command")?
        .map(|raw| text(raw, Some(320)))
        .transpose()?
        .flatten();
    selected(&mut output, "command", command.as_deref())?;
    selected(
        &mut output,
        "raw_tokens",
        field(raw, "raw_tokens")?.filter(|raw| finite(raw)),
    )?;
    output.push('}');
    Ok(output)
}

fn slice(raw: &str) -> Result<String, BtccError> {
    let mut output = String::from("{");
    selected(
        &mut output,
        "text",
        field(raw, "text")?.filter(|raw| string_raw(raw)),
    )?;
    for key in ["start_line", "start_char"] {
        selected(&mut output, key, field(raw, key)?.filter(|raw| finite(raw)))?;
    }
    selected(
        &mut output,
        "next_offset_chars",
        field(raw, "next_offset_chars")?.filter(|raw| *raw == "null" || finite(raw)),
    )?;
    for key in ["returned_lines", "total_lines", "total_chars"] {
        selected(&mut output, key, field(raw, key)?.filter(|raw| finite(raw)))?;
    }
    for key in ["truncated_by_lines", "truncated_by_tokens"] {
        selected(
            &mut output,
            key,
            field(raw, key)?.filter(|raw| boolean(raw)),
        )?;
    }
    if let Some(search) = field(raw, "search")?.filter(|raw| object(raw)) {
        selected(&mut output, "search", Some(&search_facts(search)?))?;
    }
    output.push('}');
    Ok(output)
}

fn search_facts(raw: &str) -> Result<String, BtccError> {
    let mut output = String::from("{");
    let query = field(raw, "query")?
        .map(|raw| text(raw, Some(320)))
        .transpose()?
        .flatten();
    selected(&mut output, "query", query.as_deref())?;
    selected(
        &mut output,
        "found",
        field(raw, "found")?.filter(|raw| boolean(raw)),
    )?;
    selected(
        &mut output,
        "match_char",
        field(raw, "match_char")?.filter(|raw| *raw == "null" || finite(raw)),
    )?;
    output.push('}');
    Ok(output)
}

fn text(raw: &str, max: Option<usize>) -> Result<Option<String>, BtccError> {
    if !string_raw(raw) {
        return Ok(None);
    }
    let decoded: String = serde_json::from_str(raw).map_err(|_| failure())?;
    let trimmed = crate::public_text::trim_js_whitespace(&decoded);
    if trimmed.is_empty() {
        return Ok(None);
    }
    let encoded = if let Some(max) = max {
        let prefix = Utf16Prefix::new(trimmed, max);
        let truncated = prefix.len_utf16() < trimmed.encode_utf16().count();
        let mut encoded = prefix.json_literal().map_err(|_| failure())?;
        if truncated {
            encoded.pop();
            encoded.push_str("...\"");
        }
        encoded
    } else {
        let mut encoded = String::new();
        crate::json::write_string(trimmed, &mut encoded).map_err(|_| failure())?;
        encoded
    };
    Ok(Some(encoded))
}

fn selected(output: &mut String, key: &str, raw: Option<&str>) -> Result<(), BtccError> {
    if let Some(raw) = raw {
        if output.len() > 1 {
            output.push(',');
        }
        crate::json::write_string(key, output).map_err(|_| failure())?;
        output.push(':');
        output.push_str(raw);
    }
    Ok(())
}

fn object(raw: &str) -> bool {
    raw.trim_start().starts_with('{')
}
fn string_raw(raw: &str) -> bool {
    raw.trim_start().starts_with('"')
}
fn boolean(raw: &str) -> bool {
    matches!(raw.trim(), "true" | "false")
}
fn finite(raw: &str) -> bool {
    serde_json::from_str::<f64>(raw).is_ok_and(f64::is_finite)
}
