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

/// A field as a record or tool call sent it: missing, `null`, readable as
/// `T`, or present with another shape. Use with `#[serde(default)]` so a
/// missing key reads as [`Arg::Missing`].
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum Arg<T> {
    #[default]
    Missing,
    Null,
    Valid(T),
    /// Passthrough: the value as sent, kept so comparisons and echoes of a
    /// wrong-typed field behave as they did on the raw record.
    Invalid(Value),
}

impl<T> Arg<T> {
    /// The value when it was readable.
    pub(crate) fn valid(&self) -> Option<&T> {
        match self {
            Self::Valid(value) => Some(value),
            Self::Missing | Self::Null | Self::Invalid(_) => None,
        }
    }

    /// Whether both fields hold the same JSON (missing reads as `null`), as
    /// comparing the raw records would.
    pub(crate) fn same_json(&self, other: &Self) -> bool
    where
        T: PartialEq,
    {
        match (self, other) {
            (Self::Missing | Self::Null, Self::Missing | Self::Null) => true,
            (Self::Valid(left), Self::Valid(right)) => left == right,
            (Self::Invalid(left), Self::Invalid(right)) => left == right,
            _ => false,
        }
    }
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Arg<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if value.is_null() {
            return Ok(Self::Null);
        }
        match serde_json::from_value(value.clone()) {
            Ok(valid) => Ok(Self::Valid(valid)),
            Err(_) => Ok(Self::Invalid(value)),
        }
    }
}

/// Serializes the field as it was sent (`null` when missing).
impl<T: serde::Serialize> serde::Serialize for Arg<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Missing | Self::Null => serializer.serialize_none(),
            Self::Valid(value) => value.serialize(serializer),
            Self::Invalid(value) => value.serialize(serializer),
        }
    }
}

/// A nested record that must be a JSON object (serde would also read a
/// struct from an array, positionally).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Obj<T>(pub T);

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Obj<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if !value.is_object() {
            return Err(serde::de::Error::custom("expected an object"));
        }
        serde_json::from_value(value)
            .map(Obj)
            .map_err(serde::de::Error::custom)
    }
}

/// Reads a record or tool arguments into `T` (whose fields all default);
/// a value that is not an object reads as all fields missing.
pub(crate) fn view<T: serde::de::DeserializeOwned + Default>(value: &Value) -> T {
    if value.is_object() {
        serde_json::from_value(value.clone()).unwrap_or_default()
    } else {
        T::default()
    }
}

/// Reads the string items of an array, skipping items of other types; a
/// value that is not an array reads as empty.
pub(crate) fn string_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    strings(deserializer).map(Option::unwrap_or_default)
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

/// Reads of stored JSON that cannot panic: the same result as `value[key]`
/// (`null` when the value is not an object or has no such key).
pub(crate) trait JsonField {
    /// The field, or `null`.
    fn field(&self, key: &str) -> &Value;
}

impl JsonField for Value {
    fn field(&self, key: &str) -> &Value {
        static NULL: Value = Value::Null;
        self.get(key).unwrap_or(&NULL)
    }
}

/// Sets a field of a JSON object record (a no-op on other values).
pub(crate) fn set_field(record: &mut Value, key: &str, value: Value) {
    if let Some(object) = record.as_object_mut() {
        object.insert(key.to_owned(), value);
    }
}
