//! Pure catalog identity and guided-call envelope interpretation.

use std::borrow::Cow;

use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolCatalogProvider {
    Native,
    Mcp,
    Plugin,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ParsedToolCatalogId<'a> {
    pub provider: ToolCatalogProvider,
    pub namespace: Option<Cow<'a, str>>,
    pub name: Cow<'a, str>,
}

pub(crate) struct NormalizedGuidedToolCall<'a> {
    pub name: Cow<'a, str>,
}

pub(crate) fn parse_tool_catalog_id(id: &str) -> Option<ParsedToolCatalogId<'_>> {
    let mut parts = id.split(':');
    let provider = match parts.next()? {
        "native" => ToolCatalogProvider::Native,
        "mcp" => ToolCatalogProvider::Mcp,
        "plugin" => ToolCatalogProvider::Plugin,
        _ => return None,
    };
    let first = parts.next()?;
    let (namespace, name) = if provider == ToolCatalogProvider::Native {
        (None, first)
    } else {
        (Some(decode_segment(first)), parts.next()?)
    };
    if parts.next().is_some() {
        return None;
    }
    Some(ParsedToolCatalogId {
        provider,
        namespace,
        name: decode_segment(name),
    })
}

pub(crate) fn normalize_guided_tool_call<'a>(
    tool_name: &'a str,
    args: &'a Map<String, Value>,
) -> NormalizedGuidedToolCall<'a> {
    let nested = args.get("arguments").and_then(Value::as_object);
    let target = args
        .get("id")
        .and_then(Value::as_str)
        .and_then(parse_tool_catalog_id);
    if let (Some(_), Some(target)) = (nested, target)
        && !target.name.is_empty()
        && target.name != "tool_call"
        && (tool_name == "tool_call" || target.name == tool_name)
    {
        return NormalizedGuidedToolCall { name: target.name };
    }
    NormalizedGuidedToolCall {
        name: Cow::Borrowed(tool_name),
    }
}

// Source decodeURIComponent failures become an empty segment. A percent sign
// starts a byte escape; '+' remains literal and encoded separators stay inside
// their original segment. Invalid or surrogate UTF-8 sequences fail together.
fn decode_segment(value: &str) -> Cow<'_, str> {
    let Some(first_escape) = value.bytes().position(|byte| byte == b'%') else {
        return Cow::Borrowed(value);
    };
    let mut decoded = Vec::with_capacity(value.len());
    decoded.extend_from_slice(&value.as_bytes()[..first_escape]);
    let mut remaining = &value.as_bytes()[first_escape..];
    while let Some((&byte, tail)) = remaining.split_first() {
        if byte != b'%' {
            decoded.push(byte);
            remaining = tail;
            continue;
        }
        let Some((&high, tail)) = tail.split_first() else {
            return Cow::Borrowed("");
        };
        let Some((&low, tail)) = tail.split_first() else {
            return Cow::Borrowed("");
        };
        let (Some(high), Some(low)) = (hex(high), hex(low)) else {
            return Cow::Borrowed("");
        };
        decoded.push((high << 4) | low);
        remaining = tail;
    }
    String::from_utf8(decoded)
        .map(Cow::Owned)
        .unwrap_or(Cow::Borrowed(""))
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
