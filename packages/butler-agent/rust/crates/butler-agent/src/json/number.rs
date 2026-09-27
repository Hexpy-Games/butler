//! ECMAScript Number conversion for existing JSON arguments and config strings.
//! Callers retain authority over absent/null defaults, validation and clamping.

use super::JsonError;
use serde_json::Value;

pub(crate) fn coerce_number(value: &Value) -> Result<f64, JsonError> {
    validate_primitive_conversion(value)?;
    Ok(match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => number_from_string(value),
        Value::Array(values) => array_number(values),
        Value::Object(_) => f64::NAN,
    })
}

// JSON cannot carry callable valueOf/toString methods. An own toString shadows
// Object.prototype.toString, so ordinary primitive conversion throws instead
// of producing "[object Object]". Array joining visits its elements first,
// even when the resulting comma-separated text could never be numeric.
fn validate_primitive_conversion(value: &Value) -> Result<(), JsonError> {
    match value {
        Value::Object(value) if value.contains_key("toString") => {
            return Err(JsonError::ObjectToPrimitive);
        }
        Value::Array(values) => {
            for value in values {
                validate_primitive_conversion(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

// JSON arrays stringify with commas, nulls as empty text, and numbers with
// ECMAScript spelling. Any comma makes Number invalid. Borrow the sole element
// instead of allocating a potentially large joined string.
fn array_number(mut values: &[Value]) -> f64 {
    loop {
        match values {
            [] | [Value::Null] => return 0.0,
            [Value::Array(nested)] => values = nested,
            [Value::String(value)] => return number_from_string(value),
            [Value::Number(value)] => {
                let number = value.as_f64().unwrap_or(f64::NAN);
                return if number == 0.0 { 0.0 } else { number };
            }
            _ => return f64::NAN,
        }
    }
}

pub(crate) fn number_from_string(value: &str) -> f64 {
    let value = crate::public_text::trim_js_whitespace(value);
    match value {
        "" => return 0.0,
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, bits) in [
        ("0x", 4),
        ("0X", 4),
        ("0o", 3),
        ("0O", 3),
        ("0b", 1),
        ("0B", 1),
    ] {
        if let Some(digits) = value.strip_prefix(prefix) {
            return radix_number(digits, bits);
        }
    }
    if !is_decimal(value.as_bytes()) {
        return f64::NAN;
    }
    value.parse::<f64>().unwrap_or(f64::NAN)
}

fn is_decimal(bytes: &[u8]) -> bool {
    let mut index = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let mut digits = 0;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
        digits += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

// Match Bun/JSC's observed low-order-first radix accumulation. For long
// inputs its result can differ from one final nearest-even integer rounding.
// The source-runtime bit fixtures pin this compatibility behavior. Skip zero
// terms so leading zeros never evaluate 0 * infinity to NaN.
fn radix_number(digits: &str, bits_per_digit: usize) -> f64 {
    let radix = 1u32 << bits_per_digit;
    if digits.is_empty()
        || !digits
            .bytes()
            .all(|byte| digit(byte).is_some_and(|n| n < radix))
    {
        return f64::NAN;
    }
    let mut number = 0.0;
    let mut weight = 1.0;
    for byte in digits.bytes().rev() {
        let Some(value) = digit(byte) else {
            return f64::NAN;
        };
        if value != 0 {
            number += f64::from(value) * weight;
        }
        weight *= f64::from(radix);
    }
    number
}

fn digit(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some(u32::from(byte - b'0')),
        b'a'..=b'f' => Some(u32::from(byte - b'a' + 10)),
        b'A'..=b'F' => Some(u32::from(byte - b'A' + 10)),
        _ => None,
    }
}
