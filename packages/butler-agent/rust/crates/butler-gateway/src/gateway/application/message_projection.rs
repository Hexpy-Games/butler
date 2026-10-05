//! Terminal assistant-message delivery, work-block, and activity projection.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::storage::AppStorageError;
use crate::gateway::{MessageRecord, MessageRole, ProgressState, TurnProgressSnapshotView};

mod work_blocks;
#[cfg(test)]
mod work_blocks_tests;

pub(super) fn decorate(
    db: &Connection,
    messages: &mut [MessageRecord],
    progress: &BTreeMap<String, TurnProgressSnapshotView>,
) -> Result<(), AppStorageError> {
    for message in messages {
        if !matches!(&message.role, MessageRole::Assistant) {
            continue;
        }
        let Some(turn) = message.turn_id.as_deref() else {
            continue;
        };
        let Some(snapshot) = progress.get(turn).filter(|value| {
            terminal(value.state.as_ref())
                || matches!(message.status, crate::gateway::MessageStatus::Delivered)
        }) else {
            continue;
        };
        let previous_end: Option<String> = db.query_row(
            "SELECT updated_at FROM messages WHERE chat_id=?1 AND turn_id=?2 AND role='assistant' \
             AND rowid<?3 ORDER BY rowid DESC LIMIT 1",
            rusqlite::params![message.chat_id, turn, message.cursor], |row| row.get(0),
        ).optional().map_err(AppStorageError::sqlite)?;
        let mut snapshot = snapshot.clone();
        snapshot.safe_progress_rows.retain(|row| {
            let at = row.get("created_at").and_then(Value::as_str);
            at.is_none_or(|at| {
                previous_end.as_deref().is_none_or(|end| at > end)
                    && at <= message.updated_at.as_str()
            })
        });
        let explicit = db
            .query_row(
                "SELECT delivery_metadata_json FROM app_terminal_turn_projections WHERE turn_id=?1",
                [turn],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(AppStorageError::sqlite)?
            .flatten()
            .is_some();
        if explicit {
            message.delivery_state = snapshot.delivery_state.clone();
            message.limitation_codes = snapshot.limitation_codes.clone();
            message.limitations = snapshot.limitations.clone();
        }
        let blocks = work_blocks::project(&snapshot.safe_progress_rows);
        message.work_blocks = Some(blocks);
        let activity = snapshot
            .safe_progress_rows
            .iter()
            .filter(|row| is_activity(row))
            .cloned()
            .collect::<Vec<_>>();
        message.turn_activity_rows = Some(activity);
    }
    Ok(())
}

fn terminal(state: Option<&ProgressState>) -> bool {
    matches!(
        state,
        Some(
            ProgressState::Delivered
                | ProgressState::Failed
                | ProgressState::Cancelled
                | ProgressState::RuntimeFault
        )
    )
}

fn is_activity(row: &Value) -> bool {
    let Some(row) = row.as_object() else {
        return false;
    };
    let kind = string(row, "kind");
    let bridge = string(row, "bridge_phase");
    kind == Some("todo") && bridge == Some("btcc_work_ledger")
        || bridge == Some("btcc_operation") && truthy_string(row, "semantic_block_id")
        || kind == Some("message")
            && !truthy_string(row, "work_block_id")
            && truthy_string(row, "semantic_block_id")
            && string(row, "work_decision_source") == Some("model-authored")
            && truthy_string(row, "work_decision_summary")
}

fn string<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn truthy_string(row: &Map<String, Value>, key: &str) -> bool {
    string(row, key).is_some_and(|value| !value.is_empty())
}
