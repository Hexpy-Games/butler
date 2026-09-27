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
