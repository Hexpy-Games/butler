use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::json;

use super::common::{canonical_json, error, json as parse_json};
use super::{StorageError, StorageResult};
use crate::btcc::EventVisibility;
use crate::btcc::ProgressDestination;
use crate::btcc::identity::digest;
use crate::btcc::turn::ProgressWrite;

pub(super) fn append(connection: &mut Connection, write: ProgressWrite) -> StorageResult<()> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::sqlite)?;
    let mut event = write.event;
    if event.created_at.is_none() {
        event.created_at = Some(
            tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::sqlite)?,
        );
    }
    if event.visibility.is_none() {
        event.visibility = Some(EventVisibility::Public);
    }
    let event =
        serde_json::to_value(event).map_err(|cause| error("progress_event", cause.to_string()))?;
    let fingerprint = digest(&canonical_json(
        &json!({"kind":event["kind"],"visibility":event["visibility"],"payload":event.get("payload").cloned().unwrap_or_else(||json!({}))}),
    )?);
    let destination = serde_json::to_value(&write.destination)
        .map_err(|e| error("progress_destination", e.to_string()))?;
    let destination_json = canonical_json(&destination)?;
    let event_id = format!(
        "btcc-progress-event:{}",
        digest(&format!(
            "btcc-progress-event.v1\0{}\0{fingerprint}",
            write.turn_id
        ))
    );
    let action_id = format!(
        "btcc-progress-action:{}",
        digest(&canonical_json(
            &json!({"version":1,"eventId":event_id,"destination":destination})
        )?)
    );
    let exists = tx
        .query_row(
            "SELECT 1 FROM btcc_progress_events WHERE turn_id=?1 AND event_fingerprint=?2",
            params![write.turn_id, fingerprint],
            |_| Ok(()),
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .is_some();
    if !exists {
        let session_sequence:u64=tx.query_row("SELECT COALESCE(MAX(session_sequence),0)+1 FROM btcc_progress_events WHERE session_id=?1",[&write.session_id],|r|r.get(0)).map_err(StorageError::sqlite)?;
        let turn_sequence:u64=tx.query_row("SELECT COALESCE(MAX(turn_sequence),0)+1 FROM btcc_progress_events WHERE turn_id=?1",[&write.turn_id],|r|r.get(0)).map_err(StorageError::sqlite)?;
        tx.execute("INSERT INTO btcc_progress_events (event_id,action_id,session_id,turn_id,
            session_sequence,turn_sequence,event_fingerprint,event_json,destination_json,status,created_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![event_id,action_id,write.session_id,write.turn_id,session_sequence,turn_sequence,
                fingerprint,canonical_json(&event)?,destination_json]).map_err(StorageError::sqlite)?;
    }
    tx.commit().map_err(StorageError::sqlite)
}

pub(super) fn first_destination(
    connection: &Connection,
    turn_id: &str,
) -> StorageResult<Option<ProgressDestination>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT destination_json FROM btcc_progress_events
        WHERE turn_id=?1 ORDER BY turn_sequence ASC,event_id ASC LIMIT 1",
            [turn_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    raw.map(|raw| {
        let destination: ProgressDestination =
            serde_json::from_value(parse_json(&raw, "progress_destination")?)
                .map_err(|e| error("progress_destination", e.to_string()))?;
        Ok(destination)
    })
    .transpose()
}
