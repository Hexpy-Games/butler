use rusqlite::Connection;
use serde_json::Value;

use super::{StorageError, StorageResult};
use crate::btcc::BtccError;
use crate::btcc::identity::sqlite_stable_json;
use crate::btcc::turn::{ExecutionRoute, TurnSemanticState};

pub(super) fn btcc_error(error: StorageError) -> BtccError {
    BtccError::new(error.code, error.message)
}

pub(super) fn error(code: &'static str, message: impl Into<String>) -> StorageError {
    StorageError::new(code, message)
}

pub(super) fn json(value: &str, code: &'static str) -> StorageResult<Value> {
    serde_json::from_str(value).map_err(|error| StorageError::new(code, error.to_string()))
}

pub(super) fn canonical_json(value: &Value) -> StorageResult<String> {
    sqlite_stable_json(value).map_err(|error| StorageError::new("canonical_json", error.message))
}

/// ECMAScript JSON.stringify object enumeration over an insertion-preserving Value.
pub(super) fn stringify(value: &Value) -> StorageResult<String> {
    crate::json::stringify(value)
        .map_err(|error| StorageError::new("json_stringify", error.to_string()))
}

pub(super) fn state_text(state: TurnSemanticState) -> &'static str {
    match state {
        TurnSemanticState::Admitted => "admitted",
        TurnSemanticState::DeliveryCommitted => "delivery_committed",
        TurnSemanticState::Delivered => "delivered",
        TurnSemanticState::Cancelled => "cancelled",
    }
}

pub(super) fn parse_state(value: &str) -> StorageResult<TurnSemanticState> {
    match value {
        "admitted" => Ok(TurnSemanticState::Admitted),
        "delivery_committed" => Ok(TurnSemanticState::DeliveryCommitted),
        "delivered" => Ok(TurnSemanticState::Delivered),
        "cancelled" => Ok(TurnSemanticState::Cancelled),
        _ => Err(error(
            "invalid_turn_state",
            format!("BTCC R3 Turn state is invalid: {value}"),
        )),
    }
}

pub(super) fn route_text(route: ExecutionRoute) -> &'static str {
    match route {
        ExecutionRoute::Direct => "direct",
        ExecutionRoute::Assisted => "assisted",
        ExecutionRoute::Managed => "managed",
    }
}

pub(super) fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> StorageResult<bool> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(StorageError::sqlite)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(StorageError::sqlite)?;
    for name in names {
        if name.map_err(StorageError::sqlite)? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
