//! Public progress read model combining retained terminal snapshots with the live replay tail.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

mod rows;
#[cfg(test)]
mod rows_tests;

use super::storage::AppStorageError;
use crate::gateway::{DeliveryState, ProgressState, TurnProgressSnapshotView};

const INTERNAL_CODES: &[&str] = &[
    "internal_recovery_required",
    "goal_completion_incomplete",
    "app_turn_queue_failed",
    "completion_review_incomplete",
];

pub(super) fn read(
    db: &Connection,
    turn_id: &str,
) -> Result<Option<TurnProgressSnapshotView>, AppStorageError> {
    let turn = db
        .query_row(
            "SELECT state,safe_status_label,safe_error_code,updated_at FROM turns WHERE id=?1",
            [turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some((state, label, error, updated_at)) = turn else {
        return Ok(None);
    };
    let retained = db
        .query_row(
            "SELECT progress_rows_json,source_event_high_water,delivery_metadata_json FROM app_terminal_turn_projections WHERE turn_id=?1",
            [turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<String>>(2)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let (mut rows, high_water, retained_delivery) = match retained {
        Some((json, cursor, delivery)) => (parse_rows(&json)?, cursor, delivery),
        None => (Vec::new(), 0, None),
    };
    let mut retained_rows = db.prepare(
        "SELECT row_json FROM app_terminal_turn_progress_rows WHERE turn_id=?1 ORDER BY source_event_id",
    ).map_err(AppStorageError::sqlite)?;
    let encoded_rows = retained_rows
        .query_map([turn_id], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    for encoded in encoded_rows {
        rows.push(serde_json::from_str(&encoded).map_err(json_error)?);
    }
    let mut statement = db.prepare(
        "SELECT payload_json FROM events WHERE id>?1 AND turn_id=?2 AND type IN ('progress.summary','agent.turn_event.progress') AND NOT (type='agent.turn_event.progress' AND EXISTS (SELECT 1 FROM app_internal_continuation_progress_events hidden WHERE hidden.turn_id=?2 AND hidden.event_id=json_extract(events.payload_json,'$.event_id'))) ORDER BY id",
    ).map_err(AppStorageError::sqlite)?;
    let live = statement
        .query_map(params![high_water, turn_id], |row| row.get::<_, String>(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    for encoded in live {
        let payload: Value = serde_json::from_str(&encoded).map_err(json_error)?;
        if let Some(row) = payload.get("row").filter(|value| value.is_object()) {
            rows.push(row.clone());
        }
    }
    rows = rows::public_rows(rows, &state);
    let suppressed = error
        .as_deref()
        .is_some_and(|code| INTERNAL_CODES.contains(&code));
    let delivery = retained_delivery
        .as_deref()
        .and_then(|encoded| serde_json::from_str::<Value>(encoded).ok());
    let projected_delivery = delivery
        .as_ref()
        .and_then(|value| value.get("delivery_state"))
        .and_then(Value::as_str)
        .map(delivery_state)
        .unwrap_or_else(|| delivery_state(&state));
    let internal_delivery = delivery
        .as_ref()
        .and_then(|value| value.get("delivery_state"))
        .and_then(Value::as_str)
        .is_some_and(is_internal_delivery);
    let limitation_codes = delivery
        .as_ref()
        .and_then(|value| value.get("limitation_codes"))
        .and_then(Value::as_array)
        .map(|values| string_list(values))
        .unwrap_or_default();
    let limitations = delivery
        .as_ref()
        .and_then(|value| value.get("limitations"))
        .and_then(Value::as_array)
        .map(|values| string_list(values))
        .unwrap_or_default();
    let (limitation_codes, limitations) = if internal_delivery {
        (Vec::new(), Vec::new())
    } else {
        (limitation_codes, limitations)
    };
    Ok(Some(TurnProgressSnapshotView {
        summary_reference: None,
        summary: (!suppressed && !label.trim().is_empty()).then_some(label),
        updated_at: Some(updated_at),
        turn_id: Some(turn_id.to_owned()),
        state: Some(progress_state(&state)?),
        delivery_state: Some(projected_delivery),
        limitations: Some(limitations),
        limitation_codes: Some(limitation_codes),
        safe_progress_rows: rows,
    }))
}

fn parse_rows(encoded: &str) -> Result<Vec<Value>, AppStorageError> {
    serde_json::from_str(encoded).map_err(json_error)
}

fn progress_state(value: &str) -> Result<ProgressState, AppStorageError> {
    serde_json::from_value(Value::String(value.to_owned())).map_err(json_error)
}
fn delivery_state(value: &str) -> DeliveryState {
    match value {
        "running" => DeliveryState::Running,
        "waiting_user" | "waiting_for_form" => DeliveryState::WaitingUser,
        "system_error" => DeliveryState::SystemError,
        "delivered" => DeliveryState::Delivered,
        "delivered_with_limitations" => DeliveryState::DeliveredWithLimitations,
        "delivered_with_continuation" => DeliveryState::DeliveredWithContinuation,
        "failed_system" | "failed" | "runtime_fault" => DeliveryState::FailedSystem,
        "cancelled" => DeliveryState::Cancelled,
        value if is_internal_delivery(value) => DeliveryState::Running,
        _ => DeliveryState::Running,
    }
}
fn is_internal_delivery(value: &str) -> bool {
    matches!(
        value,
        "recovering_internal" | "needs_tool_surface" | "needs_evidence" | "needs_argument_repair"
    )
}
fn string_list(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new("app_projection_json_invalid", error.to_string())
}
