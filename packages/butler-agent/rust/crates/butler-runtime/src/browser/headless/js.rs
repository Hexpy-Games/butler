//! JavaScript value semantics the ported executor logic relies on.
use serde_json::Value;

/// `String(value)` for JSON values (`undefined`/`null` read as "").
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map_or_else(|| n.to_string(), number),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A finite number as JavaScript prints it (integers without a fraction).
pub(crate) fn number(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else if value.is_nan() {
        "NaN".to_owned()
    } else {
        value.to_string()
    }
}

/// `Math.round`: halves round toward positive infinity.
pub(crate) fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A number as JSON the way JavaScript serializes it: integral values
/// without a fraction (`640`, not `640.0`).
pub(crate) fn jnum(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "integral and within the exact f64 integer range"
        )]
        let integer = value as i64;
        Value::from(integer)
    } else {
        Value::from(value)
    }
}

/// The number at `value`, or `fallback`.
pub(crate) fn num(value: &Value, fallback: f64) -> f64 {
    value.as_f64().unwrap_or(fallback)
}
