//! Bounded reads of committed progress facts; delivery acknowledgment is separate.

use rusqlite::{Connection, params};
use serde_json::Value;

use super::{BtccStorage, StorageError, StorageResult};
use crate::btcc::{ProgressDestination, RuntimeTurnEventInput};

#[cfg(test)]
mod operation_output_tests;

pub(crate) struct CommittedProgressEvent {
    pub event_id: String,
    pub action_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub session_sequence: u64,
    pub turn_sequence: u64,
    pub event: RuntimeTurnEventInput,
    pub destination: ProgressDestination,
}

#[derive(Clone)]
pub(crate) struct StorageProgressPublication {
    storage: BtccStorage,
}

impl StorageProgressPublication {
    pub(crate) fn new(storage: BtccStorage) -> Self {
        Self { storage }
    }

    /// Source order is session_sequence then event_id. A keyset bounds both
    /// transient hydration and a reconcile pass when an earlier event fails.
    pub(crate) async fn pending_page(
        &self,
        after: Option<(u64, String)>,
        limit: usize,
    ) -> StorageResult<Vec<CommittedProgressEvent>> {
        let limit = i64::try_from(limit.clamp(1, 64)).unwrap_or(64);
        self.storage
            .execute(move |connection| pending_page(connection, after, limit))
            .await
    }

    pub(crate) async fn mark_published(&self, event_id: &str) -> StorageResult<()> {
        let event_id = event_id.to_owned();
        self.storage
            .execute(move |connection| {
                connection
                    .execute(
                        "UPDATE btcc_progress_events SET status='published' \
                         WHERE event_id=?1 AND status='pending'",
                        [&event_id],
                    )
                    .map_err(StorageError::sqlite)?;
                Ok(())
            })
            .await
    }

    /// Reads public operation-output progress only when the turn belongs to a
    /// persisted child-session relation. App projects the source payload into
    /// its narrower typed response after this owner check.
    pub(crate) async fn read_child_operation_output_events(
        &self,
        turn_id: String,
        request_id: String,
        result_id: String,
    ) -> StorageResult<Vec<Value>> {
        self.storage
            .execute(move |connection| {
                read_child_operation_output_events(connection, &turn_id, &request_id, &result_id)
            })
            .await
    }
}

fn read_child_operation_output_events(
    connection: &Connection,
    turn_id: &str,
    request_id: &str,
    result_id: &str,
) -> StorageResult<Vec<Value>> {
    let mut statement = connection
        .prepare(
            "SELECT p.event_json FROM btcc_progress_events AS p \
             JOIN btcc_turns AS t ON t.turn_id=p.turn_id AND t.session_id=p.session_id \
             JOIN btcc_session_relations AS r ON r.child_session_id=t.session_id \
             WHERE p.turn_id=?1 ORDER BY p.turn_sequence ASC,p.event_id ASC",
        )
        .map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map([turn_id], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?;
    let mut events = Vec::new();
    for row in rows {
        let raw = row.map_err(StorageError::sqlite)?;
        let Ok(event) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let is_exact_public_chunk = event.get("kind").and_then(Value::as_str)
            == Some("operation.output.chunk")
            && event.get("visibility").and_then(Value::as_str) == Some("public")
            && event.pointer("/payload/requestId").and_then(Value::as_str) == Some(request_id)
            && event.pointer("/payload/resultId").and_then(Value::as_str) == Some(result_id);
        if is_exact_public_chunk {
            events.push(event);
        }
    }
    Ok(events)
}

fn pending_page(
    connection: &Connection,
    after: Option<(u64, String)>,
    limit: i64,
) -> StorageResult<Vec<CommittedProgressEvent>> {
    let (sequence, event_id) = match after {
        Some((sequence, event_id)) => (Some(sequence), event_id),
        None => (None, String::new()),
    };
    let mut statement = connection
        .prepare(
            "SELECT event_id,action_id,session_id,turn_id,session_sequence,turn_sequence, \
                    event_json,destination_json FROM btcc_progress_events \
             WHERE status='pending' AND (?1 IS NULL OR session_sequence>?1 \
                OR (session_sequence=?1 AND event_id>?2)) \
             ORDER BY session_sequence ASC,event_id ASC LIMIT ?3",
        )
        .map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(params![sequence, event_id, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, u64>(4)?,
                row.get::<_, u64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(StorageError::sqlite)?;
    rows.map(|row| {
        let (
            event_id,
            action_id,
            session_id,
            turn_id,
            session_sequence,
            turn_sequence,
            event,
            destination,
        ) = row.map_err(StorageError::sqlite)?;
        let event = serde_json::from_str(&event)
            .map_err(|error| StorageError::new("progress_event_invalid", error.to_string()))?;
        let destination = serde_json::from_str(&destination).map_err(|error| {
            StorageError::new("progress_destination_invalid", error.to_string())
        })?;
        Ok(CommittedProgressEvent {
            event_id,
            action_id,
            session_id,
            turn_id,
            session_sequence,
            turn_sequence,
            event,
            destination,
        })
    })
    .collect()
}
