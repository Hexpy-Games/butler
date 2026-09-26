use super::operation_input::TurnVersion;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;

use super::common::{canonical_json, error, route_text, state_text, stringify};
use super::{StorageError, StorageResult};
use crate::btcc::identity::digest;
use crate::btcc::turn::{
    DeliveryStatus, StateExecutionClaim, SuspensionReason, TurnCheckpoint, TurnSemanticState,
    TurnTransition,
};

pub(super) fn commit(
    connection: &mut Connection,
    turn: &TurnVersion,
    claim: &StateExecutionClaim,
    transition: &TurnTransition,
) -> StorageResult<()> {
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    assert_current_claim(&transaction, turn, claim)?;
    consume_claim(&transaction, claim)?;
    let next_revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| error("turn_revision_overflow", "BTCC Turn revision overflow"))?;
    match transition {
        TurnTransition::Suspend {
            reason,
            authority_continuation,
        } => suspend(
            &transaction,
            turn,
            next_revision,
            *reason,
            authority_continuation.as_ref(),
        )?,
        TurnTransition::AcceptFinal {
            route,
            payload,
            outbox,
        } => accept_final(&transaction, turn, next_revision, *route, payload, outbox)?,
        TurnTransition::ObserveDelivery {
            assistant_message_id,
        } => observe_delivery(&transaction, turn, next_revision, assistant_message_id)?,
    }
    transaction.commit().map_err(StorageError::sqlite)
}

pub(super) fn resume_authority(connection: &mut Connection, turn_id: &str) -> StorageResult<()> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(StorageError::sqlite)?;
    let ready = transaction
        .query_row(
            "SELECT turn.revision, turn.context_json, request.request_ref, \
             request.schedule_client_message_id FROM btcc_turns turn \
             JOIN btcc_authority_requests request \
             ON request.request_ref = json_extract(turn.authority_continuation_json, '$.requestRef') \
             AND request.source_turn_id = turn.turn_id \
             AND request.source_call_id = json_extract(turn.authority_continuation_json, '$.callId') \
             WHERE turn.turn_id = ?1 AND turn.semantic_state = 'admitted' \
             AND turn.suspension_reason = 'authority_pending' \
             AND request.decision IN ('allowed','denied','modified') AND request.close_reason IS NULL",
            [turn_id],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?,
                row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
        )
        .optional().map_err(StorageError::sqlite)?;
    let Some((old_revision, context_json, request_ref, client_message_id)) = ready else {
        transaction.commit().map_err(StorageError::sqlite)?;
        return Ok(());
    };
    let revision = old_revision
        .checked_add(1)
        .ok_or_else(|| error("turn_revision_overflow", "BTCC Turn revision overflow"))?;
    let checkpoint = checkpoint_for(turn_id, revision, TurnSemanticState::Admitted);
    let mut context = super::common::json(&context_json, "invalid_turn_context")?;
    let object = context.as_object_mut().ok_or_else(|| {
        error(
            "invalid_turn_context",
            "BTCC Turn context must be an object",
        )
    })?;
    object.insert("authorityRequestRef".to_owned(), Value::String(request_ref));
    object.insert(
        "authorityClientMessageId".to_owned(),
        Value::String(client_message_id),
    );
    let changed = transaction
        .execute(
            "UPDATE btcc_turns SET suspension_reason = NULL, revision = ?1, \
         active_checkpoint_id = ?2, context_json = ?3 WHERE turn_id = ?4 AND revision = ?5 \
         AND suspension_reason = 'authority_pending'",
            params![
                revision,
                checkpoint.checkpoint_id,
                stringify(&context)?,
                turn_id,
                old_revision
            ],
        )
        .map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            "transition_contention",
            "BTCC authority resume lost Turn CAS",
        ));
    }
    insert_checkpoint(&transaction, turn_id, revision, &checkpoint)?;
    transaction.commit().map_err(StorageError::sqlite)
}

fn suspend(
    connection: &Connection,
    turn: &TurnVersion,
    next_revision: u64,
    reason: SuspensionReason,
    continuation: Option<&Value>,
) -> StorageResult<()> {
    if turn.semantic_state != TurnSemanticState::Admitted {
        return Err(error(
            "invalid_suspension_transition",
            "BTCC suspension can only commit from admitted",
        ));
    }
    if reason == SuspensionReason::AuthorityPending {
        let continuation = continuation.ok_or_else(|| {
            error(
                "authority_continuation_missing",
                "authority_continuation_missing",
            )
        })?;
        let request_ref = continuation
            .get("requestRef")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                error(
                    "authority_continuation_invalid",
                    "authority requestRef missing",
                )
            })?;
        let call_id = continuation
            .get("callId")
            .and_then(Value::as_str)
            .ok_or_else(|| error("authority_continuation_invalid", "authority callId missing"))?;
        let bound = connection
            .execute(
                "UPDATE btcc_authority_requests SET source_call_id = ?1 WHERE request_ref = ?2 \
             AND source_turn_id = ?3 AND decision = 'pending' AND close_reason IS NULL \
             AND (source_call_id IS NULL OR source_call_id = ?1)",
                params![call_id, request_ref, turn.turn_id],
            )
            .map_err(StorageError::sqlite)?;
        if bound != 1 {
            return Err(error(
                "authority_source_call_mismatch",
                "authority_source_call_mismatch",
            ));
        }
        let pending = connection.execute(
            "UPDATE btcc_guided_tool_calls SET status = 'awaiting_authority' WHERE call_id = ?1 \
             AND turn_id = ?2 AND status IN ('started','awaiting_authority')",
            params![call_id, turn.turn_id],
        ).map_err(StorageError::sqlite)?;
        if pending != 1 {
            return Err(error(
                "authority_source_call_not_pending",
                "authority_source_call_not_pending",
            ));
        }
    }
    let continuation_json = continuation.map(stringify).transpose()?;
    let changed = connection
        .execute(
            "UPDATE btcc_turns SET suspension_reason = ?1, authority_continuation_json = ?2, \
         active_checkpoint_id = NULL, revision = ?3 WHERE turn_id = ?4 AND revision = ?5 \
         AND semantic_state = 'admitted' AND active_checkpoint_id = ?6 AND execution_fence = ?7",
            params![
                match reason {
                    SuspensionReason::AuthorityPending => "authority_pending",
                    SuspensionReason::WaitingForWorker => "waiting_for_worker",
                },
                continuation_json,
                next_revision,
                turn.turn_id,
                turn.revision,
                turn.checkpoint
                    .as_ref()
                    .map(|checkpoint| checkpoint.checkpoint_id.as_str())
                    .unwrap_or(""),
                turn.execution_fence
            ],
        )
        .map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            "transition_contention",
            "BTCC suspension commit lost Turn CAS",
        ));
    }
    Ok(())
}

fn accept_final(
    connection: &Connection,
    turn: &TurnVersion,
    next_revision: u64,
    route: crate::btcc::turn::ExecutionRoute,
    payload: &crate::btcc::turn::FinalPayload,
    outbox: &crate::btcc::turn::DeliveryOutbox,
) -> StorageResult<()> {
    if turn.semantic_state != TurnSemanticState::Admitted
        || outbox.status != DeliveryStatus::Pending
        || outbox.final_payload_ref != payload.reference
        || outbox.content != payload.content
    {
        return Err(error(
            "invalid_final_transition",
            "BTCC R3 final does not match its immutable Outbox",
        ));
    }
    let payload_value = serde_json::to_value(payload)
        .map_err(|error| StorageError::new("invalid_final_payload", error.to_string()))?;
    let payload_json = canonical_json(&payload_value)?;
    insert_immutable_record(
        connection,
        &payload.reference.id,
        "final_payload",
        &payload.reference.sha256,
        &payload_json,
    )?;
    connection.execute(
        "INSERT INTO btcc_delivery_outbox (outbox_id, turn_id, committed_turn_revision, payload_id, \
         payload_sha256, expected_message_id, content, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')",
        params![outbox.outbox_id, turn.turn_id, next_revision, payload.reference.id,
            payload.reference.sha256, outbox.expected_message_id, outbox.content],
    ).map_err(StorageError::sqlite)?;
    let checkpoint = checkpoint_for(
        turn.turn_id.as_str(),
        next_revision,
        TurnSemanticState::DeliveryCommitted,
    );
    let changed = connection.execute(
        "UPDATE btcc_turns SET semantic_state = 'delivery_committed', active_checkpoint_id = ?1, \
         route = ?2, final_payload_json = ?3, delivery_outbox_id = ?4, revision = ?5, \
         final_disposition = 'completed' WHERE turn_id = ?6 AND revision = ?7 \
         AND semantic_state = 'admitted' AND active_checkpoint_id IS ?8 AND execution_fence = ?9",
        params![checkpoint.checkpoint_id, route_text(route), payload_json, outbox.outbox_id,
            next_revision, turn.turn_id, turn.revision,
            turn.checkpoint.as_ref().map(|checkpoint| checkpoint.checkpoint_id.as_str()),
            turn.execution_fence],
    ).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            "transition_contention",
            "BTCC R3 final commit lost Turn CAS",
        ));
    }
    insert_checkpoint(connection, &turn.turn_id, next_revision, &checkpoint)
}

fn observe_delivery(
    connection: &Connection,
    turn: &TurnVersion,
    next_revision: u64,
    assistant_message_id: &str,
) -> StorageResult<()> {
    let Some(outbox) = turn.delivery_outbox.as_ref() else {
        return Err(error(
            "invalid_delivery_observation",
            "BTCC R3 delivery observation lacks a committed Outbox",
        ));
    };
    if turn.semantic_state != TurnSemanticState::DeliveryCommitted {
        return Err(error(
            "invalid_delivery_observation",
            "BTCC R3 delivery observation lacks a committed Outbox",
        ));
    }
    let status = connection
        .query_row(
            "SELECT status FROM btcc_delivery_outbox WHERE outbox_id = ?1 AND turn_id = ?2 \
         AND expected_message_id = ?3",
            params![outbox.outbox_id, turn.turn_id, assistant_message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    if status.as_deref() != Some("inserted") {
        return Err(error(
            "canonical_message_not_inserted",
            "BTCC R3 delivery observation has no inserted canonical message",
        ));
    }
    if connection
        .execute(
            "UPDATE btcc_delivery_outbox SET status = 'observed' \
        WHERE outbox_id = ?1 AND status = 'inserted'",
            [&outbox.outbox_id],
        )
        .map_err(StorageError::sqlite)?
        != 1
    {
        return Err(error(
            "transition_contention",
            "BTCC R3 delivery Outbox observation raced",
        ));
    }
    let changed = connection.execute(
        "UPDATE btcc_turns SET semantic_state = 'delivered', active_checkpoint_id = NULL, \
         canonical_assistant_message_id = ?1, revision = ?2 WHERE turn_id = ?3 AND revision = ?4 \
         AND semantic_state = 'delivery_committed' AND active_checkpoint_id = ?5 AND execution_fence = ?6",
        params![assistant_message_id, next_revision, turn.turn_id, turn.revision,
            turn.checkpoint.as_ref().map(|checkpoint| checkpoint.checkpoint_id.as_str()).unwrap_or(""),
            turn.execution_fence],
    ).map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error(
            "transition_contention",
            "BTCC R3 delivery commit lost Turn CAS",
        ));
    }
    Ok(())
}

fn assert_current_claim(
    connection: &Connection,
    turn: &TurnVersion,
    claim: &StateExecutionClaim,
) -> StorageResult<()> {
    let current = connection
        .query_row(
            "SELECT semantic_state, revision, execution_fence, active_checkpoint_id \
        FROM btcc_turns WHERE turn_id = ?1",
            [&turn.turn_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let owned = connection
        .query_row(
            "SELECT turn_id, turn_revision, semantic_state, checkpoint_id, \
        checkpoint_revision, execution_fence, status FROM btcc_state_claims WHERE claim_id = ?1",
            [&claim.claim_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, u64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let checkpoint = turn.checkpoint.as_ref();
    let valid = current.is_some_and(|row| {
        row.0 == state_text(turn.semantic_state)
            && row.1 == turn.revision
            && row.2 == turn.execution_fence
            && row.3.as_deref() == checkpoint.map(|value| value.checkpoint_id.as_str())
    }) && checkpoint.is_some_and(|checkpoint| {
        claim.turn_id == turn.turn_id
            && claim.turn_revision == turn.revision
            && claim.semantic_state == turn.semantic_state
            && claim.checkpoint_id == checkpoint.checkpoint_id
            && claim.checkpoint_revision == checkpoint.checkpoint_revision
            && claim.execution_fence == turn.execution_fence
    }) && owned.is_some_and(|row| {
        row.0 == claim.turn_id
            && row.1 == claim.turn_revision
            && row.2 == state_text(claim.semantic_state)
            && row.3 == claim.checkpoint_id
            && row.4 == claim.checkpoint_revision
            && row.5 == claim.execution_fence
            && row.6 == "active"
    });
    if !valid {
        return Err(error(
            "transition_claim_lost",
            "BTCC R3 transition lost its exact Turn claim",
        ));
    }
    Ok(())
}

fn consume_claim(connection: &Connection, claim: &StateExecutionClaim) -> StorageResult<()> {
    if connection
        .execute(
            "UPDATE btcc_state_claims SET status = 'consumed' WHERE claim_id = ?1 \
        AND status = 'active'",
            [&claim.claim_id],
        )
        .map_err(StorageError::sqlite)?
        != 1
    {
        return Err(error(
            "transition_claim_inactive",
            "BTCC R3 transition claim was not active",
        ));
    }
    if connection
        .execute(
            "UPDATE btcc_checkpoints SET is_active = 0, active_claim_id = NULL \
        WHERE checkpoint_id = ?1 AND active_claim_id = ?2 AND is_active = 1",
            params![claim.checkpoint_id, claim.claim_id],
        )
        .map_err(StorageError::sqlite)?
        != 1
    {
        return Err(error(
            "transition_checkpoint_inactive",
            "BTCC R3 transition checkpoint was not actively claimed",
        ));
    }
    Ok(())
}

fn checkpoint_for(turn_id: &str, revision: u64, state: TurnSemanticState) -> TurnCheckpoint {
    TurnCheckpoint {
        checkpoint_id: digest(&format!(
            "btcc-checkpoint.v1\0{turn_id}\0{revision}\0{}",
            state_text(state)
        )),
        checkpoint_revision: 1,
        semantic_state: state,
    }
}

fn insert_checkpoint(
    connection: &Connection,
    turn_id: &str,
    revision: u64,
    checkpoint: &TurnCheckpoint,
) -> StorageResult<()> {
    connection.execute("INSERT INTO btcc_checkpoints (checkpoint_id, turn_id, turn_revision, \
        semantic_state, kind, checkpoint_revision, is_active) VALUES (?1, ?2, ?3, ?4, 'runtime', ?5, 1)",
        params![checkpoint.checkpoint_id, turn_id, revision, state_text(checkpoint.semantic_state),
            checkpoint.checkpoint_revision]).map_err(StorageError::sqlite)?;
    Ok(())
}

fn insert_immutable_record(
    connection: &Connection,
    id: &str,
    kind: &str,
    sha: &str,
    content: &str,
) -> StorageResult<()> {
    connection
        .execute(
            "INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json) \
        VALUES (?1, ?2, ?3, ?4)",
            params![id, kind, sha, content],
        )
        .map_err(StorageError::sqlite)?;
    let stored = connection
        .query_row(
            "SELECT kind, sha256, content_json FROM btcc_records WHERE record_id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(StorageError::sqlite)?;
    if stored != (kind.to_owned(), sha.to_owned(), content.to_owned()) {
        return Err(error(
            "immutable_record_conflict",
            format!("Immutable BTCC record conflict: {id}"),
        ));
    }
    Ok(())
}
