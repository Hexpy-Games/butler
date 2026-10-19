//! Wire-format strings and JSON-like object decoding, without changing string content.
use serde_json::{Map, Value};

pub(super) fn object(value: &str) -> Option<Map<String, Value>> {
    let value = value.trim();
    if value.is_empty() || value.len() > 8_000 || !value.starts_with('{') || !value.ends_with('}') {
        return None;
    }
    let normalized = repair(value)?;
    serde_json::from_str::<Value>(&normalized)
        .ok()?
        .as_object()
        .cloned()
}

fn repair(value: &str) -> Option<String> {
    const DELIMITER: &str = "<|\"|>";
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor < value.len() {
        let rest = &value[cursor..];
        if let Some(inner) = rest.strip_prefix(DELIMITER) {
            let end = inner.find(DELIMITER)?;
            output.push_str(&serde_json::to_string(&inner[..end]).ok()?);
            cursor += DELIMITER.len() * 2 + end;
        } else if rest.starts_with('"') {
            let size = quoted_length(rest)?;
            output.push_str(&rest[..size]);
            cursor += size;
        } else if rest.starts_with(',') && rest[1..].trim_start().starts_with(['}', ']']) {
            cursor += 1;
        } else {
            let ch = rest.chars().next()?;
            if (ch.is_ascii_alphabetic() || ch == '_') && output.trim_end().ends_with(['{', ',']) {
                let end = rest
                    .find(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
                    .unwrap_or(rest.len());
                if rest[end..].trim_start().starts_with(':') {
                    output.push_str(&serde_json::to_string(&rest[..end]).ok()?);
                    cursor += end;
                    continue;
                }
            }
            output.push(ch);
            cursor += ch.len_utf8();
        }
    }
    Some(output)
}

fn quoted_length(text: &str) -> Option<usize> {
    let mut escaped = false;
    for (index, ch) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(index + 1);
        }
    }
    None
}
