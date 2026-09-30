//! Durable outbound staging and legacy-compatible projection receipts.

use crate::gateway::application::storage::CachedSql;
use rusqlite::{Connection, OptionalExtension, params};

use super::{super::storage::AppStorageError, TranscriptEvent};
use crate::gateway::application::storage::AppStorageCode;

pub(super) fn stage(
    db: &Connection,
    action_id: &str,
    chat_id: &str,
    event: &TranscriptEvent,
    claim_id: Option<&str>,
    now: &str,
) -> Result<(), AppStorageError> {
    let event_json = serde_json::to_string(event).map_err(|error| {
        AppStorageError::new(AppStorageCode::AppProjectionJsonInvalid, error.to_string())
            .with_source(error)
    })?;
    if let Some(existing) = load(db, action_id)? {
        let existing_claim = claim_id_from_event(&existing.1);
        if existing_claim.is_some() && existing_claim.as_deref() != claim_id {
            db.execute_cached(
                "DELETE FROM app_transport_projection_staged_outbounds WHERE action_id=?1",
                [action_id],
            )
            .map_err(AppStorageError::sqlite)?;
        }
    }
    db.execute_cached(
        "INSERT OR IGNORE INTO app_transport_projection_staged_outbounds \
         (action_id,chat_id,event_json,state,created_at,updated_at) \
         VALUES(?1,?2,?3,'awaiting_delivery',?4,?4)",
        params![action_id, chat_id, event_json, now],
    )
    .map_err(AppStorageError::sqlite)?;
    let stored = load(db, action_id)?.ok_or_else(|| {
        AppStorageError::new(
            AppStorageCode::AppStagedOutboundMissing,
            "Staged outbound was not found.",
        )
    })?;
    if stored.0 != chat_id || !same_action(&stored.1, event) {
        return Err(AppStorageError::new(
            AppStorageCode::AppStagedOutboundIdentityConflict,
            "Transport staged outbound identity conflict",
        ));
    }
    Ok(())
}

/// Whether a staged outbound and a newly read one carry the same action. A
/// runtime that sends an action again (the progress and final it re-delivers
/// after a restart, a delivery retry) writes a new transcript record: a new
/// event id and timestamp, and its own delivery bookkeeping in the record's
/// `metadata`. Only the action itself (kind, session, transport and payload)
/// must match. Comparing the whole record turned an action re-sent while its
/// first record was still staged (its delivery was read under a claim the
/// restarted App had already recovered) into an identity conflict the
/// projection retried forever, so the chat's turns never settled.
pub(super) fn same_action(stored: &TranscriptEvent, event: &TranscriptEvent) -> bool {
    stored.kind == event.kind
        && stored.session_id == event.session_id
        && stored.transport == event.transport
        && stored.payload == event.payload
}

pub(super) fn load(
    db: &Connection,
    action_id: &str,
) -> Result<Option<(String, TranscriptEvent)>, AppStorageError> {
    db.query_row_cached(
        "SELECT chat_id,event_json FROM app_transport_projection_staged_outbounds \
         WHERE action_id=?1",
        [action_id],
        |row| {
            let json: String = row.get(1)?;
            let event = serde_json::from_str(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok((row.get(0)?, event))
        },
    )
    .optional()
    .map_err(AppStorageError::sqlite)
}

pub(super) fn load_awaiting(
    db: &Connection,
    action_id: &str,
) -> Result<Option<(String, TranscriptEvent)>, AppStorageError> {
    let Some(row) = load(db, action_id)? else {
        return Ok(None);
    };
    let awaiting = db
        .query_row_cached(
            "SELECT state FROM app_transport_projection_staged_outbounds WHERE action_id=?1",
            [action_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(AppStorageError::sqlite)?
        == "awaiting_delivery";
    Ok(awaiting.then_some(row))
}

pub(super) fn defer(db: &Connection, action_id: &str, now: &str) -> Result<(), AppStorageError> {
    db.execute_cached(
        "UPDATE app_transport_projection_staged_outbounds SET state='deferred_final',updated_at=?1 \
         WHERE action_id=?2 AND state='awaiting_delivery'",
        params![now, action_id],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn deferred_batch(
    db: &Connection,
    after: &str,
    limit: usize,
) -> Result<Vec<(String, String, TranscriptEvent)>, AppStorageError> {
    let mut statement = db
        .prepare_cached(
            "SELECT action_id,chat_id,event_json FROM app_transport_projection_staged_outbounds \
             WHERE state='deferred_final' AND action_id>?1 ORDER BY action_id LIMIT ?2",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map(params![after, limit], |row| {
            let encoded: String = row.get(2)?;
            let event = serde_json::from_str(&encoded).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok((row.get(0)?, row.get(1)?, event))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

pub(super) fn delete(db: &Connection, action_id: &str) -> Result<(), AppStorageError> {
    db.execute_cached(
        "DELETE FROM app_transport_projection_staged_outbounds WHERE action_id=?1",
        [action_id],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn projected(db: &Connection, action_id: &str) -> Result<bool, AppStorageError> {
    let current = db
        .query_row_cached(
            "SELECT 1 FROM app_transport_projection_receipts WHERE action_id=?1",
            [action_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .is_some();
    if current {
        return Ok(true);
    }
    let migrated = db
        .query_row_cached(
            "SELECT completed FROM app_transport_projection_migrations \
             WHERE name='projected_transport_events_to_app_receipts_v1'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        == Some(1);
    if migrated {
        return Ok(false);
    }
    db.query_row_cached(
        "SELECT 1 FROM projected_transport_events WHERE action_id=?1",
        [action_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(AppStorageError::sqlite)
}

pub(super) fn mark(
    db: &Connection,
    action_id: &str,
    event_id: &str,
    chat_id: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    db.execute_cached(
        "INSERT OR IGNORE INTO app_transport_projection_receipts \
         (action_id,event_id,chat_id,created_at) VALUES(?1,?2,?3,?4)",
        params![action_id, event_id, chat_id, now],
    )
    .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn claim_id_from_event(event: &TranscriptEvent) -> Option<String> {
    event
        .payload
        .get("metadata")
        .and_then(|value| value.get("appQueueClaimId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests;
