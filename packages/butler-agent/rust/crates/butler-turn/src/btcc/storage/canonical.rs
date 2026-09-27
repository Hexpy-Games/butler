use rusqlite::{Connection, OptionalExtension, params};

use super::common::error;
use super::operation_input::CanonicalDelivery;
use super::{StorageError, StorageResult};
use crate::btcc::StorageCode;

pub(super) fn insert(
    connection: &mut Connection,
    turn: &CanonicalDelivery,
) -> StorageResult<String> {
    let outbox = turn.delivery_outbox.as_ref().ok_or_else(|| {
        error(
            StorageCode::CanonicalOutboxMissing,
            "BTCC canonical delivery requires an Outbox",
        )
    })?;
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    let stored = transaction
        .query_row(
            "SELECT payload_id, payload_sha256, expected_message_id, content, status \
             FROM btcc_delivery_outbox WHERE outbox_id = ?1 AND turn_id = ?2",
            params![outbox.outbox_id, turn.turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if !stored.is_some_and(|stored| {
        stored.0 == outbox.final_payload_ref.id
            && stored.1 == outbox.final_payload_ref.sha256
            && stored.2 == outbox.expected_message_id
            && stored.3 == outbox.content
            && matches!(stored.4.as_str(), "pending" | "inserted" | "observed")
    }) {
        return Err(error(
            StorageCode::CanonicalOutboxMismatch,
            "BTCC canonical delivery does not match its immutable Outbox",
        ));
    }
    let existing = transaction
        .query_row(
            "SELECT content FROM btcc_messages WHERE message_id = ?1",
            [&outbox.expected_message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if existing
        .as_deref()
        .is_some_and(|content| content != outbox.content)
    {
        return Err(error(
            StorageCode::CanonicalMessageConflict,
            "BTCC canonical assistant message identity conflict",
        ));
    }
    if existing.is_none() {
        transaction
            .execute(
                "INSERT INTO btcc_messages (message_id, session_id, turn_id, role, content, \
             idempotency_key, created_at) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, \
             strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
                params![
                    outbox.expected_message_id,
                    turn.session_id,
                    turn.turn_id,
                    outbox.content,
                    format!("delivery:{}", outbox.outbox_id)
                ],
            )
            .map_err(StorageError::sqlite)?;
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO btcc_canonical_deliveries (turn_id, outbox_id, \
         assistant_message_id, inserted_at) VALUES (?1, ?2, ?3, \
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![turn.turn_id, outbox.outbox_id, outbox.expected_message_id],
        )
        .map_err(StorageError::sqlite)?;
    let delivery = transaction.query_row(
        "SELECT outbox_id, assistant_message_id FROM btcc_canonical_deliveries WHERE turn_id = ?1",
        [&turn.turn_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .optional().map_err(StorageError::sqlite)?;
    if !delivery.is_some_and(|delivery| {
        delivery.0 == outbox.outbox_id && delivery.1 == outbox.expected_message_id
    }) {
        return Err(error(
            StorageCode::CanonicalDeliveryConflict,
            "BTCC canonical delivery identity conflict",
        ));
    }
    transaction
        .execute(
            "UPDATE btcc_delivery_outbox SET status = 'inserted' \
         WHERE outbox_id = ?1 AND status = 'pending'",
            [&outbox.outbox_id],
        )
        .map_err(StorageError::sqlite)?;
    transaction.commit().map_err(StorageError::sqlite)?;
    Ok(outbox.expected_message_id.clone())
}
