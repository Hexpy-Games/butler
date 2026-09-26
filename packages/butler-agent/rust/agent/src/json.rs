//! ECMAScript JSON bytes and explicit serde byte counting for shared consumers.
//! This codec has no domain, storage, or runtime ownership dependencies.

use serde_json::Value;
use std::borrow::Cow;
use unicode_normalization::UnicodeNormalization;

mod utf16_prefix;
pub(crate) use utf16_prefix::Utf16Prefix;
mod utf16_slice;
pub(crate) use utf16_slice::Utf16Slice;
mod document;
pub(crate) use document::JsonDocument;
pub(crate) use document::{
    bound_raw_string, raw_string_contains_any, raw_string_units, visit_raw_array, visit_raw_object,
};
mod number;
pub(crate) use number::{coerce_number, number_from_string};

/// Builds a JSON object literal as a `serde_json::Map`, so callers can insert
/// or remove keys without unwrapping `Value::as_object_mut`.
macro_rules! json_object {
    ({ $($body:tt)* }) => {
        match ::serde_json::json!({ $($body)* }) {
            ::serde_json::Value::Object(map) => map,
            // `json!({ .. })` always builds an object.
            _ => ::serde_json::Map::new(),
        }
    };
}
pub(crate) use json_object;

/// `value` as a mutable object; any other value is first replaced by `{}`.
pub(crate) fn object_mut(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => {
            *other = Value::Object(serde_json::Map::new());
            object_mut(other)
        }
    }
}

/// `parent[key]` as a mutable object; a missing or non-object value becomes `{}`.
pub(crate) fn object_field_mut<'a>(
    parent: &'a mut serde_json::Map<String, Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, Value> {
    object_mut(
        parent
            .entry(key)
            .or_insert_with(|| Value::Object(serde_json::Map::new())),
    )
}

#[derive(Debug)]
pub(crate) struct JsonError(String);
impl JsonError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}
impl std::fmt::Display for JsonError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for JsonError {}

#[derive(Clone, Copy)]
pub(crate) enum CanonicalKeyOrder {
    Utf16Lexical,
    JsPropertyEnumeration,
}

pub(crate) fn canonical_json(value: &Value, order: CanonicalKeyOrder) -> Result<String, JsonError> {
    encode(
        value,
        match order {
            CanonicalKeyOrder::Utf16Lexical => JsonOrder::LexicalCanonical,
            CanonicalKeyOrder::JsPropertyEnumeration => JsonOrder::PropertyCanonical,
        },
        None,
    )
}

pub(crate) fn stringify(value: &Value) -> Result<String, JsonError> {
    encode(value, JsonOrder::Insertion, None)
}

/// Sort object keys stably, then apply ECMAScript property enumeration.
/// Strings and keys retain their original Unicode representation. The caller
/// owns comparison policy; this codec never creates or retains a collator.
pub(crate) fn stringify_sorted(
    value: &Value,
    compare: &dyn Fn(&str, &str) -> std::cmp::Ordering,
) -> Result<String, JsonError> {
    encode(value, JsonOrder::PropertySorted(compare), None)
}

/// Serialize transformed string values without cloning the containing DOM.
/// Keys retain ECMAScript enumeration order and are never transformed.
pub(crate) fn stringify_with_string_projection(
    value: &Value,
    mut project: impl FnMut(&str) -> Option<String>,
) -> Result<String, JsonError> {
    let mut output = String::new();
    write_value(
        value,
        &mut output,
        JsonOrder::Insertion,
        None,
        &mut Some(&mut project),
    )?;
    Ok(output)
}

pub(crate) fn stringify_without(value: &Value, field: &str) -> Result<String, JsonError> {
    encode(value, JsonOrder::Insertion, Some(field))
}

/// Append borrowed JSON without allocating an intermediate encoded string.
/// As with the other writers, callers discard the output if encoding fails.
pub(crate) fn append_json(value: &Value, output: &mut String) -> Result<(), JsonError> {
    write_value(value, output, JsonOrder::Insertion, None, &mut None)
}

fn encode(value: &Value, order: JsonOrder<'_>, omit: Option<&str>) -> Result<String, JsonError> {
    let mut output = String::new();
    write_value(value, &mut output, order, omit, &mut None)?;
    Ok(output)
}

#[derive(Clone, Copy)]
enum JsonOrder<'a> {
    LexicalCanonical,
    PropertyCanonical,
    Insertion,
    PropertySorted(&'a dyn Fn(&str, &str) -> std::cmp::Ordering),
}

type StringProjection<'a> = Option<&'a mut dyn FnMut(&str) -> Option<String>>;

fn write_value(
    value: &Value,
    output: &mut String,
    order: JsonOrder<'_>,
    omit_field: Option<&str>,
    project: &mut StringProjection<'_>,
) -> Result<(), JsonError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            let value = value
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| JsonError::new("invalid JSON number"))?;
            output.push_str(ryu_js::Buffer::new().format_finite(value));
        }
        Value::String(value) => {
            let replacement = project.as_mut().and_then(|project| project(value));
            write_string(
                &normalized(replacement.as_deref().unwrap_or(value), order),
                output,
            )?;
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_value(value, output, order, None, project)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut children = values
                .iter()
                .filter(|(key, _)| Some(key.as_str()) != omit_field)
                .map(|(key, value)| (normalized(key, order), value))
                .collect::<Vec<_>>();
            children.sort_by(|left, right| {
                let lexical = || left.0.encode_utf16().cmp(right.0.encode_utf16());
                if matches!(order, JsonOrder::LexicalCanonical) {
                    return lexical();
                }
                match (array_index(&left.0), array_index(&right.0)) {
                    (Some(left), Some(right)) => left.cmp(&right),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => match order {
                        JsonOrder::Insertion => std::cmp::Ordering::Equal,
                        JsonOrder::PropertySorted(compare) => compare(&left.0, &right.0),
                        _ => lexical(),
                    },
                }
            });
            if children.windows(2).any(|pair| pair[0].0 == pair[1].0) {
                return Err(JsonError::new("duplicate normalized object key"));
            }
            output.push('{');
            for (index, (key, value)) in children.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_string(&key, output)?;
                output.push(':');
                write_value(value, output, order, None, project)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

pub(crate) fn write_string(value: &str, output: &mut String) -> Result<(), JsonError> {
    serde_json::to_writer(Utf8Output(output), value)
        .map_err(|error| JsonError::new(error.to_string()))
}

/// Measure the same escaped UTF-8 string bytes without retaining encoded output.
/// The counting sink uses the writer's serializer, including both quote bytes.
pub(crate) fn string_bytes(value: &str) -> Result<usize, JsonError> {
    serde_serialized_bytes(value)
}

/// Count serde JSON bytes without retaining encoded output or cloning the input.
/// This is not the ECMAScript codec: in particular, serde number formatting can
/// differ from JSON.stringify. Callers needing JS byte limits must establish
/// encoding equivalence for their DTO (for example, a string/null-only DTO).
pub(crate) fn serde_serialized_bytes<T: serde::Serialize + ?Sized>(
    value: &T,
) -> Result<usize, JsonError> {
    let mut output = ByteCount(0);
    serde_json::to_writer(&mut output, value).map_err(|error| JsonError::new(error.to_string()))?;
    Ok(output.0)
}

struct ByteCount(usize);

impl std::io::Write for ByteCount {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.checked_add(bytes.len()).ok_or_else(|| {
            std::io::Error::other("serialized JSON byte count exceeds addressable size")
        })?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Append serializer fragments without a second encoded copy of large strings.
struct Utf8Output<'a>(&'a mut String);

impl std::io::Write for Utf8Output<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let text = std::str::from_utf8(bytes)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        self.0.push_str(text);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn normalized<'a>(value: &'a str, order: JsonOrder<'_>) -> Cow<'a, str> {
    match order {
        JsonOrder::LexicalCanonical | JsonOrder::PropertyCanonical => {
            Cow::Owned(value.nfc().collect())
        }
        JsonOrder::Insertion | JsonOrder::PropertySorted(_) => Cow::Borrowed(value),
    }
}

// Object.fromEntries followed by JSON.stringify enumerates array-index keys
// numerically before the remaining keys, even after canonical key sorting.
fn array_index(key: &str) -> Option<u32> {
    let value = key.parse::<u32>().ok()?;
    (value < u32::MAX && value.to_string() == key).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_byte_count_includes_json_escapes_and_utf8() {
        for (value, expected) in [
            ("", 2),
            ("\"\\\n\r\t\u{8}\u{c}", 16),
            ("\u{0}\u{1f}", 14),
            ("한글😀\u{2028}\u{2029}", 18),
        ] {
            assert_eq!(string_bytes(value).unwrap(), expected);
        }
        let body = "x".repeat(1024 * 1024);
        assert_eq!(string_bytes(&body).unwrap(), body.len() + 2);
    }

    #[test]
    fn string_projection_retains_property_order_and_original_input() {
        let source: Value = serde_json::from_str(
            r#"{"10":"data:image/png;base64,x","label":"한글\n😀","2":["keep",{"data:image/png;base64,key":"replace"}],"01":1e-7}"#,
        ).unwrap();
        let original = stringify(&source).unwrap();
        let projected = stringify_with_string_projection(&source, |value| {
            (value == "replace" || value.starts_with("data:image/")).then(|| "projected".into())
        })
        .unwrap();
        assert_eq!(
            projected,
            "{\"2\":[\"keep\",{\"data:image/png;base64,key\":\"projected\"}],\"10\":\"projected\",\"label\":\"한글\\n😀\",\"01\":1e-7}"
        );
        assert_eq!(stringify(&source).unwrap(), original);
        assert_eq!(
            stringify_with_string_projection(&source, |_| None).unwrap(),
            original
        );
    }

    #[test]
    fn sorted_json_preserves_collation_ties_and_distinct_unicode_keys() {
        let input: Value = serde_json::from_str(
            r#"{"é":"é","é":"é","10":"ten","2":"two","nested":{"z":1,"a":2}}"#,
        )
        .unwrap();
        assert_eq!(
            stringify_sorted(&input, &|_, _| std::cmp::Ordering::Equal).unwrap(),
            r#"{"2":"two","10":"ten","é":"é","é":"é","nested":{"z":1,"a":2}}"#
        );
    }
}
