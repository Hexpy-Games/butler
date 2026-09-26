//! Immutable JSON bytes shared by result transport owners. The JSON body may
//! contain escaped UTF-16 boundary units that a Unicode-scalar DOM cannot hold.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};

use super::JsonError;

mod field;
mod traverse;
pub(crate) use traverse::{
    bound_raw_string, raw_string_contains_any, raw_string_units, visit_raw_array, visit_raw_object,
};

#[derive(Clone, Debug)]
pub(crate) struct JsonDocument(Arc<Box<RawValue>>);

impl JsonDocument {
    /// Validate and take already encoded bytes. This checks JSON syntax only;
    /// the producer still owns ECMAScript formatting and hash verification.
    pub(crate) fn from_encoded(encoded: String) -> Result<Self, JsonError> {
        RawValue::from_string(encoded)
            .map(|value| Self(Arc::new(value)))
            .map_err(JsonError::from)
    }

    /// Encode using the existing JS number/property ordering, not serde's DOM
    /// formatter. Callers may release their original DOM after this succeeds.
    pub(crate) fn from_value(value: &Value) -> Result<Self, JsonError> {
        Self::from_encoded(super::stringify(value)?)
    }

    pub(crate) fn as_str(&self) -> &str {
        self.0.get()
    }

    /// Borrow an encoded top-level object field; absent and non-object inputs
    /// return None. Present JSON null remains Some("null").
    pub(crate) fn field(&self, name: &str) -> Result<Option<&str>, JsonError> {
        field::field(self.as_str(), name)
    }

    /// Parse only the typed view needed by this consumer. Unknown payload
    /// fields can be skipped without retaining a second parsed result body.
    pub(crate) fn read<'a, T: Deserialize<'a>>(&'a self) -> Result<T, JsonError> {
        serde_json::from_str(self.as_str()).map_err(JsonError::from)
    }
}

impl Serialize for JsonDocument {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.as_ref().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for JsonDocument {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Box::<RawValue>::deserialize(deserializer).map(|value| Self(Arc::new(value)))
    }
}

/// Equality here is exact encoded-byte equality, not JSON semantic equality.
impl PartialEq for JsonDocument {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || self.as_str() == other.as_str()
    }
}
impl Eq for JsonDocument {}

#[cfg(test)]
mod tests;
