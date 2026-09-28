//! ECMAScript JSON bytes and explicit serde byte counting for shared consumers.
//! This codec has no domain, storage, or runtime ownership dependencies.

use serde_json::Value;
use std::borrow::Cow;
use unicode_normalization::UnicodeNormalization;

mod utf16_prefix;
pub use utf16_prefix::Utf16Prefix;
mod utf16_slice;
pub use utf16_slice::Utf16Slice;
mod document;
pub use document::JsonDocument;
pub use document::{
    bound_raw_string, raw_string_contains_any, raw_string_units, visit_raw_array, visit_raw_object,
};
mod number;
pub use number::{coerce_number, number_from_string};
mod saturating;
pub use saturating::{
    saturating_i32, saturating_i64, saturating_u16, saturating_u32, saturating_u64,
    saturating_usize,
};

/// Builds a JSON object literal as a `serde_json::Map`, so callers can insert
/// or remove keys without unwrapping `Value::as_object_mut`.
#[doc(hidden)]
#[macro_export]
macro_rules! __json_object {
    ({ $($body:tt)* }) => {
        match ::serde_json::json!({ $($body)* }) {
            ::serde_json::Value::Object(map) => map,
            // `json!({ .. })` always builds an object.
            _ => ::serde_json::Map::new(),
        }
    };
}
pub use crate::__json_object as json_object;

/// Pretty-prints a JSON value. Writing a `Value` to memory cannot fail; the
/// compact form is the fallback regardless.
pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// The value at `pointer`, reading missing members as `null` the way chained
/// `value["a"]["b"]` indexing does, without the panicking index operator.
/// Pointer segments are plain member names (no `~` or `/` escapes needed).
pub fn at<'a>(value: &'a Value, pointer: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    value.pointer(pointer).unwrap_or(&NULL)
}

/// `value` as a mutable object; any other value is first replaced by `{}`.
pub fn object_mut(value: &mut Value) -> &mut serde_json::Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => {
            *other = Value::Object(serde_json::Map::new());
            object_mut(other)
        }
    }
}

/// `parent[key]` as a mutable object; a missing or non-object value becomes `{}`.
pub fn object_field_mut<'a>(
    parent: &'a mut serde_json::Map<String, Value>,
    key: &str,
) -> &'a mut serde_json::Map<String, Value> {
    object_mut(
        parent
            .entry(key)
            .or_insert_with(|| Value::Object(serde_json::Map::new())),
    )
}

/// Failures of the crate's JSON encoders.
#[derive(Debug, thiserror::Error)]
pub enum JsonError {
    /// A number has no JSON representation (NaN or an infinity).
    #[error("invalid JSON number")]
    InvalidNumber,
    /// Two object keys became equal after Unicode normalization.
    #[error("duplicate normalized object key")]
    DuplicateNormalizedKey,
    /// An object with its own `toString` cannot be coerced to a primitive (JS parity).
    #[error("Cannot convert object to primitive value")]
    ObjectToPrimitive,
    /// A raw-JSON visitor callback failed; serde carries its text outward.
    #[error(transparent)]
    Callback(Box<dyn std::error::Error + Send + Sync>),
    /// serde_json failed to serialize or parse a value.
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

impl JsonError {
    /// Wraps a visitor callback's own error.
    pub fn callback(error: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Callback(Box::new(error))
    }
}

/// How canonical JSON orders object keys.
#[derive(Clone, Copy)]
pub enum CanonicalKeyOrder {
    /// By UTF-16 code units, as JavaScript's default string sort does.
    Utf16Lexical,
    /// In ECMAScript property enumeration order (array indices first).
    JsPropertyEnumeration,
}

/// `JSON.stringify` of `value` with keys in `order`, for digests and
/// comparisons that must not depend on insertion order.
pub fn canonical_json(value: &Value, order: CanonicalKeyOrder) -> Result<String, JsonError> {
    encode(
        value,
        match order {
            CanonicalKeyOrder::Utf16Lexical => JsonOrder::LexicalCanonical,
            CanonicalKeyOrder::JsPropertyEnumeration => JsonOrder::PropertyCanonical,
        },
        None,
    )
}

/// `JSON.stringify` of `value` in insertion order with JavaScript number
/// formatting; the byte form stored and hashed across the runtime.
pub fn stringify(value: &Value) -> Result<String, JsonError> {
    encode(value, JsonOrder::Insertion, None)
}

/// Sort object keys stably, then apply ECMAScript property enumeration.
/// Strings and keys retain their original Unicode representation. The caller
/// owns comparison policy; this codec never creates or retains a collator.
pub fn stringify_sorted(
    value: &Value,
    compare: &dyn Fn(&str, &str) -> std::cmp::Ordering,
) -> Result<String, JsonError> {
    encode(value, JsonOrder::PropertySorted(compare), None)
}

/// Serialize transformed string values without cloning the containing DOM.
/// Keys retain ECMAScript enumeration order and are never transformed.
pub fn stringify_with_string_projection(
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

/// [`stringify`] omitting the top-level member `field`.
pub fn stringify_without(value: &Value, field: &str) -> Result<String, JsonError> {
    encode(value, JsonOrder::Insertion, Some(field))
}

/// Append borrowed JSON without allocating an intermediate encoded string.
/// As with the other writers, callers discard the output if encoding fails.
pub fn append_json(value: &Value, output: &mut String) -> Result<(), JsonError> {
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
                .ok_or(JsonError::InvalidNumber)?;
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
            if children
                .windows(2)
                .any(|pair| matches!(pair, [left, right] if left.0 == right.0))
            {
                return Err(JsonError::DuplicateNormalizedKey);
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

/// Appends `value` as a JSON string literal.
pub fn write_string(value: &str, output: &mut String) -> Result<(), JsonError> {
    serde_json::to_writer(Utf8Output(output), value).map_err(JsonError::from)
}

/// Measure the same escaped UTF-8 string bytes without retaining encoded output.
/// The counting sink uses the writer's serializer, including both quote bytes.
pub fn string_bytes(value: &str) -> Result<usize, JsonError> {
    serde_serialized_bytes(value)
}

/// Count serde JSON bytes without retaining encoded output or cloning the input.
/// This is not the ECMAScript codec: in particular, serde number formatting can
/// differ from JSON.stringify. Callers needing JS byte limits must establish
/// encoding equivalence for their DTO (for example, a string/null-only DTO).
pub fn serde_serialized_bytes<T: serde::Serialize + ?Sized>(value: &T) -> Result<usize, JsonError> {
    let mut output = ByteCount(0);
    serde_json::to_writer(&mut output, value).map_err(JsonError::from)?;
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
mod tests;
