//! Shared public-text projection policy. Compiled patterns live for the process;
//! input, decoded candidates and projected output belong to each call.

mod patterns;
mod source_regex;

use std::borrow::Cow;
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use serde_json::Value;

use patterns::Patterns;
pub(crate) use source_regex::{fixed_regex, fixed_regex_ci};

static PATTERNS: LazyLock<Patterns> = LazyLock::new(Patterns::new);

pub(crate) fn sanitize_public_text(value: &str, fallback: &str) -> String {
    let stripped: Cow<'_, str> = if value.chars().any(is_control) {
        Cow::Owned(
            value
                .chars()
                .map(|c| if is_control(c) { ' ' } else { c })
                .collect(),
        )
    } else {
        Cow::Borrowed(value)
    };
    let secrets = PATTERNS.secrets.replace(&stripped, "[redacted]");
    let bearer = PATTERNS.bearer.replace(&secrets, "Bearer [redacted]");
    let normalized = collapse_whitespace(&bearer);
    if normalized.is_empty() || PATTERNS.is_private(&normalized) || decoded_private(&normalized) {
        fallback.to_owned()
    } else {
        normalized
    }
}

pub(crate) fn sanitize_public_value(value: &Value, fallback: &str) -> String {
    match value {
        Value::String(text) => sanitize_public_text(text, fallback),
        Value::Bool(value) => sanitize_public_text(if *value { "true" } else { "false" }, fallback),
        Value::Number(number) => {
            let Some(number) = number.as_f64() else {
                return fallback.to_owned();
            };
            sanitize_public_text(ryu_js::Buffer::new().format(number), fallback)
        }
        _ => fallback.to_owned(),
    }
}

pub(crate) fn trim_js_whitespace(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

pub(crate) fn trim_js_whitespace_start(value: &str) -> &str {
    value.trim_start_matches(is_js_whitespace)
}

pub(crate) fn trim_js_whitespace_end(value: &str) -> &str {
    value.trim_end_matches(is_js_whitespace)
}

fn decoded_private(value: &str) -> bool {
    // Normalized text has only ASCII spaces for ECMAScript whitespace. Avoid
    // allocating an unbounded second string for a candidate we will reject.
    let bytes = value.bytes().filter(|byte| *byte != b' ');
    let mut compact = Vec::with_capacity(value.len().min(2_048));
    for byte in bytes {
        if compact.len() == 2_048
            || !matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'=' | b'_' | b'-')
        {
            return false;
        }
        compact.push(match byte {
            b'-' => b'+',
            b'_' => b'/',
            other => other,
        });
    }
    if compact.len() < 24 {
        return false;
    }
    compact.resize(compact.len().div_ceil(4) * 4, b'=');
    let config = GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::RequireCanonical);
    let decoder = GeneralPurpose::new(&base64::alphabet::STANDARD, config);
    let Ok(decoded) = decoder.decode(compact) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&decoded) else {
        return false;
    };
    // TextDecoder's default BOM handling consumes one initial UTF-8 BOM.
    PATTERNS.is_private(text.strip_prefix('\u{feff}').unwrap_or(text))
}

fn collapse_whitespace(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if is_js_whitespace(character) {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
            }
            output.push(character);
            pending_space = false;
        }
    }
    output
}

fn is_control(character: char) -> bool {
    character < '\u{20}' || character == '\u{7f}'
}

pub(crate) fn is_js_whitespace(character: char) -> bool {
    matches!(character, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests;
