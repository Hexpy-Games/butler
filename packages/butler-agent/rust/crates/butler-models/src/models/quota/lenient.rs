//! Lenient field readers shared by the usage-endpoint parsers: providers send
//! numbers as JSON numbers or numeric strings, and times in seconds or
//! milliseconds.

use butler_core::json::saturating_i64;
use serde::{Deserialize, Deserializer};

/// A number sent as a JSON number or a numeric string.
#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    Value(f64),
    Text(String),
    Other(serde::de::IgnoredAny),
}

/// Reads an optional finite number; anything else is `None`, never an error.
pub(super) fn number<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<Number>::deserialize(deserializer)?;
    Ok(match value {
        Some(Number::Value(value)) => Some(value),
        Some(Number::Text(text)) => text.trim().parse::<f64>().ok(),
        Some(Number::Other(_)) | None => None,
    }
    .filter(|value| value.is_finite()))
}

/// Reads an optional string; any other JSON value is `None`.
pub(super) fn text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Text {
        Value(String),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Option::<Text>::deserialize(deserializer)? {
        Some(Text::Value(value)) => Some(value),
        Some(Text::Other(_)) | None => None,
    })
}

/// Epoch milliseconds of an epoch time sent in seconds or milliseconds.
pub(super) fn epoch_millis(value: f64) -> Option<i64> {
    const MILLIS_FROM: f64 = 1e12;
    const LATEST_MILLIS: f64 = 8.64e15;
    if value <= 0.0 {
        return None;
    }
    let millis = if value >= MILLIS_FROM {
        value
    } else {
        value * 1000.0
    };
    (millis <= LATEST_MILLIS).then(|| saturating_i64(millis.round()))
}

/// A plan name safe to show: letters, digits, spaces, `-` and `_`, at most
/// 40 characters.
pub(super) fn plan_name(value: Option<&str>) -> Option<String> {
    let cleaned: String = value?
        .trim()
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_')
        })
        .take(40)
        .collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_owned())
}
