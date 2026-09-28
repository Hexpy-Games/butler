//! `JSON.stringify` text of typed records.
//!
//! Stored and hashed memory JSON uses JavaScript number formatting and
//! insertion key order ([`butler_core::json::stringify`]); a typed record
//! serializes its fields in declaration order, so declaring fields in the
//! stored order keeps the bytes unchanged.

use butler_core::json::JsonError;
use serde::Serialize;

/// The `JSON.stringify` form of `value`, fields in declaration order.
pub(crate) fn stringify<T: Serialize + ?Sized>(value: &T) -> Result<String, JsonError> {
    butler_core::json::stringify(&serde_json::to_value(value)?)
}
