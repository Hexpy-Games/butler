//! Serde helpers for reading stored JSON the way the legacy JavaScript readers
//! did: a field with the wrong type reads as absent instead of failing the
//! whole record.
//!
//! Use `#[serde(default, deserialize_with = "crate::lenient::option")]` on an
//! `Option<T>` field. Use [`present`] when an explicit `null` must be told
//! apart from a missing key.

use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// Reads `T`, or `None` when the stored value is `null` or has another shape.
pub(crate) fn option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).ok())
}

/// Reads a present key (including `null`) as `Some`; with `#[serde(default)]`
/// a missing key stays `None`.
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Reads an array of records: `None` when the value is not an array, and
/// `Some(None)` for an item that is not a readable object.
pub(crate) fn items<'de, D, T>(deserializer: D) -> Result<Option<Vec<Option<T>>>, D::Error>
where
    D: Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let Value::Array(items) = Value::deserialize(deserializer)? else {
        return Ok(None);
    };
    Ok(Some(
        items
            .into_iter()
            .map(|item| {
                item.is_object()
                    .then(|| serde_json::from_value(item).ok())
                    .flatten()
            })
            .collect(),
    ))
}

/// Parses a stored JSON object into `T`; `None` for invalid JSON, a value
/// that is not an object, or an object `T` cannot read.
pub(crate) fn object<T: serde::de::DeserializeOwned>(raw: &str) -> Option<T> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value
        .is_object()
        .then(|| serde_json::from_value(value).ok())
        .flatten()
}

/// A tool argument as the caller sent it: missing, readable as `T`, or
/// present with another shape (`null` included). Use with
/// `#[serde(default)]` so a missing key reads as [`Arg::Missing`].
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum Arg<T> {
    #[default]
    Missing,
    Valid(T),
    Invalid,
}

impl<T> Arg<T> {
    /// The value when it was readable.
    pub(crate) fn valid(&self) -> Option<&T> {
        match self {
            Self::Valid(value) => Some(value),
            Self::Missing | Self::Invalid => None,
        }
    }
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Arg<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        Ok(serde_json::from_value(value).map_or(Self::Invalid, Self::Valid))
    }
}

/// Reads tool arguments into `T`; arguments that are not an object read as
/// no arguments at all.
pub(crate) fn arguments<T: serde::de::DeserializeOwned + Default>(args: &Value) -> T {
    if args.is_object() {
        serde_json::from_value(args.clone()).unwrap_or_default()
    } else {
        T::default()
    }
}

/// Reads the string items of an array, skipping items of other types;
/// `None` when the value is not an array.
pub(crate) fn strings<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let Value::Array(items) = Value::deserialize(deserializer)? else {
        return Ok(None);
    };
    Ok(Some(
        items
            .into_iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text),
                _ => None,
            })
            .collect(),
    ))
}
