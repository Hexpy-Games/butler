//! Explicit recovery of an operational failure keeps the turn and its receipts.
use super::*;
use crate::btcc::turn::TurnRecord;

pub(in crate::btcc::storage) fn resume_failed(
    connection: &mut Connection,
    turn_id: &str,
    attempt: u32,
) -> StorageResult<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::sqlite)?;
    let Some(turn) = super::super::hydration::find_turn(&transaction, turn_id)? else {
        return Ok(());
    };
    if !retryable(&turn, attempt) {
        return Ok(());
    }
    let revision = turn.revision.checked_add(1).ok_or_else(|| {
        error(
            StorageCode::TurnRevisionOverflow,
            "BTCC Turn revision overflow",
        )
    })?;
    let checkpoint = checkpoint_for(turn_id, revision, TurnSemanticState::Admitted);
    let mut context = turn.context;
    context
        .as_object_mut()
        .ok_or_else(|| {
            error(
                StorageCode::InvalidTurnCommand,
                "Turn context is not an object",
            )
        })?
        .insert("completedRecoveryAttempt".into(), Value::from(attempt));
    transaction.execute(
        "UPDATE btcc_turns SET semantic_state='admitted',revision=?1,active_checkpoint_id=?2, \
         context_json=?3,route=NULL,final_payload_json=NULL,delivery_outbox_id=NULL, \
         canonical_assistant_message_id=NULL,final_disposition=NULL WHERE turn_id=?4 AND revision=?5",
        params![revision, checkpoint.checkpoint_id, stringify(&context)?, turn_id, turn.revision],
    ).map_err(StorageError::sqlite)?;
    if let Some(previous) = &turn.checkpoint {
        transaction.execute("UPDATE btcc_checkpoints SET is_active=0,active_claim_id=NULL WHERE checkpoint_id=?1",
            [&previous.checkpoint_id]).map_err(StorageError::sqlite)?;
    }
    archive_delivery(&transaction, turn_id)?;
    insert_checkpoint(&transaction, turn_id, revision, &checkpoint)?;
    transaction.commit().map_err(StorageError::sqlite)
}

fn retryable(turn: &TurnRecord, attempt: u32) -> bool {
    turn.semantic_state == TurnSemanticState::Delivered
        && turn
            .final_payload
            .as_ref()
            .and_then(|payload| payload.runtime_failure.as_ref())
            .is_some_and(|failure| failure.retryable)
        && u64::from(attempt)
            > turn
                .context
                .get("completedRecoveryAttempt")
                .and_then(Value::as_u64)
                .unwrap_or(1)
}

/// The outbox and canonical-delivery tables describe the active delivery. An
/// explicit retry retains their complete previous rows in the immutable journal.
fn archive_delivery(connection: &Connection, turn_id: &str) -> StorageResult<()> {
    let previous: Option<(String, String)> = connection
        .query_row(
            "SELECT b.outbox_id,json_object('outboxId',b.outbox_id,'turnId',b.turn_id, \
         'committedTurnRevision',b.committed_turn_revision,'payloadId',b.payload_id, \
         'payloadSha256',b.payload_sha256,'expectedMessageId',b.expected_message_id, \
         'content',b.content,'status',b.status,'assistantMessageId',d.assistant_message_id, \
         'insertedAt',d.inserted_at) FROM btcc_delivery_outbox b \
         LEFT JOIN btcc_canonical_deliveries d ON d.outbox_id=b.outbox_id WHERE b.turn_id=?1",
            [turn_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if let Some((outbox, content)) = previous {
        insert_immutable_record(
            connection,
            &digest(&format!("btcc-completed-delivery.v1\0{outbox}")),
            "completed_delivery",
            &digest(&content),
            &content,
        )?;
    }
    connection
        .execute(
            "DELETE FROM btcc_canonical_deliveries WHERE turn_id=?1",
            [turn_id],
        )
        .map_err(StorageError::sqlite)?;
    connection
        .execute(
            "DELETE FROM btcc_delivery_outbox WHERE turn_id=?1",
            [turn_id],
        )
        .map_err(StorageError::sqlite)?;
    Ok(())
}
