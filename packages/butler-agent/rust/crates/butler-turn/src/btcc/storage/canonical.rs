use rusqlite::{Connection, OptionalExtension, params};

use super::common::error;
use super::operation_input::CanonicalDelivery;
use super::{StorageError, StorageResult};
use crate::btcc::{DeliveryOutbox, StorageCode};

/// Inserts the turn's canonical assistant message from its immutable Outbox
/// (idempotently) and marks the Outbox inserted; returns the message id.
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
    let outbox = load_outbox_identity(&transaction, turn, outbox)?;
    insert_message(&transaction, turn, &outbox)?;
    record_delivery(&transaction, turn, &outbox)?;
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

/// The stored Outbox must still belong to the same turn, revision and message.
fn load_outbox_identity(
    transaction: &Connection,
    turn: &CanonicalDelivery,
    outbox: &DeliveryOutbox,
) -> StorageResult<DeliveryOutbox> {
    let stored = transaction
        .query_row(
            "SELECT payload_id, payload_sha256, expected_message_id, content, status, committed_turn_revision \
             FROM btcc_delivery_outbox WHERE outbox_id = ?1 AND turn_id = ?2",
            params![outbox.outbox_id, turn.turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, u64>(5)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?
        .ok_or_else(|| error(StorageCode::CanonicalOutboxMissing, "BTCC delivery Outbox is missing"))?;
    if stored.1 != outbox.final_payload_ref.sha256 || stored.3 != outbox.content {
        butler_core::diagnostic!("warning: outbox content mismatch for {}", outbox.outbox_id);
    }
    if stored.0 != outbox.final_payload_ref.id
        || stored.2 != outbox.expected_message_id
        || !(stored.5 == turn.revision
            || (stored.4 == "observed" && stored.5.checked_add(1) == Some(turn.revision)))
        || !matches!(stored.4.as_str(), "pending" | "inserted" | "observed")
    {
        return Err(error(
            StorageCode::CanonicalOutboxMismatch,
            "BTCC canonical delivery does not match its immutable Outbox",
        ));
    }
    let mut delivery = outbox.clone();
    delivery.content = stored.3;
    delivery.final_payload_ref.sha256 = stored.1;
    Ok(delivery)
}

/// Inserts the assistant message unless the same message already exists;
/// a message belonging to another turn/session/role is a conflict.
fn insert_message(
    transaction: &Connection,
    turn: &CanonicalDelivery,
    outbox: &DeliveryOutbox,
) -> StorageResult<()> {
    let existing = transaction
        .query_row(
            "SELECT session_id, turn_id, role, idempotency_key, content FROM btcc_messages WHERE message_id = ?1",
            [&outbox.expected_message_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    match existing {
        Some(row)
            if row.0 != turn.session_id
                || row.1 != turn.turn_id
                || row.2 != "assistant"
                || row.3 != format!("delivery:{}", outbox.outbox_id) =>
        {
            Err(error(
                StorageCode::CanonicalMessageConflict,
                "BTCC canonical assistant message identity conflict",
            ))
        }
        Some(row) => {
            if row.4 != outbox.content {
                butler_core::diagnostic!(
                    "warning: canonical message content mismatch for {}",
                    outbox.outbox_id
                );
            }
            Ok(())
        }
        None => {
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
            Ok(())
        }
    }
}

/// Records the turn's canonical delivery; one already recorded must match.
fn record_delivery(
    transaction: &Connection,
    turn: &CanonicalDelivery,
    outbox: &DeliveryOutbox,
) -> StorageResult<()> {
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
    Ok(())
}
