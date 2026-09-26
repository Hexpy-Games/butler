use rusqlite::{Connection, OptionalExtension, params};

use super::common::error;
use super::hydration::hydrate_final_payload;
use super::{StorageError, StorageResult};
use crate::btcc::AlreadyDeliveredOutcome;
use crate::btcc::identity::digest;
use crate::btcc::turn::StopPersistenceOutcome;

struct ControlRow {
    session_id: String,
    semantic_state: String,
    revision: u64,
    execution_fence: u64,
    canonical_message_id: Option<String>,
    final_payload_json: Option<String>,
}

pub(super) fn stop(
    connection: &mut Connection,
    turn_id: &str,
) -> StorageResult<StopPersistenceOutcome> {
    let transaction = connection.transaction().map_err(StorageError::sqlite)?;
    let turn = transaction
        .query_row(
            "SELECT session_id, semantic_state, revision, execution_fence, \
             canonical_assistant_message_id, final_payload_json FROM btcc_turns WHERE turn_id=?1",
            [turn_id],
            |row| {
                Ok(ControlRow {
                    session_id: row.get(0)?,
                    semantic_state: row.get(1)?,
                    revision: row.get(2)?,
                    execution_fence: row.get(3)?,
                    canonical_message_id: row.get(4)?,
                    final_payload_json: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let request_id = digest(&format!("btcc-stop-request.v1\0{turn_id}"));
    let outcome =
        match turn {
            None => {
                transaction.execute(
                "INSERT OR IGNORE INTO btcc_stop_requests (stop_request_id, turn_id, status, \
                 observed_turn_revision, created_at, updated_at) VALUES \
                 (?1, ?2, 'cancelled_before_admission', -1, datetime('now'), datetime('now'))",
                params![request_id, turn_id],
            ).map_err(StorageError::sqlite)?;
                StopPersistenceOutcome::Cancelled
            }
            Some(turn) => persist_existing(&transaction, turn_id, &request_id, turn)?,
        };
    transaction.commit().map_err(StorageError::sqlite)?;
    Ok(outcome)
}

fn persist_existing(
    connection: &Connection,
    turn_id: &str,
    request_id: &str,
    turn: ControlRow,
) -> StorageResult<StopPersistenceOutcome> {
    let prior: Option<String> = connection
        .query_row(
            "SELECT status FROM btcc_stop_requests WHERE stop_request_id=?1",
            [request_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO btcc_stop_requests (stop_request_id, turn_id, status, \
         observed_turn_revision, created_at, updated_at) VALUES \
         (?1, ?2, 'installed', ?3, datetime('now'), datetime('now'))",
            params![request_id, turn_id, turn.revision],
        )
        .map_err(StorageError::sqlite)?;
    match turn.semantic_state.as_str() {
        "delivered" => delivered(connection, turn_id, request_id, turn),
        "cancelled" => {
            close_stop(connection, request_id, "already_cancelled", turn.revision)?;
            if prior.as_deref().is_none_or(|status| status == "installed") {
                close_authority(connection, &turn.session_id)?;
            }
            Ok(StopPersistenceOutcome::AlreadyCancelled)
        }
        "delivery_committed" => {
            close_stop(connection, request_id, "already_finalizing", turn.revision)?;
            Ok(StopPersistenceOutcome::AlreadyFinalizing)
        }
        "admitted" => cancel(connection, turn_id, request_id, &turn),
        value => Err(error(
            "invalid_turn_state",
            format!("BTCC R3 Turn state is invalid: {value}"),
        )),
    }
}

fn delivered(
    connection: &Connection,
    turn_id: &str,
    request_id: &str,
    turn: ControlRow,
) -> StorageResult<StopPersistenceOutcome> {
    close_stop(connection, request_id, "already_delivered", turn.revision)?;
    let payload = turn
        .final_payload_json
        .as_deref()
        .map(hydrate_final_payload)
        .transpose()?
        .ok_or_else(|| {
            error(
                "stop_final_missing",
                "Delivered BTCC R3 Turn has no final payload",
            )
        })?;
    let message_id = turn.canonical_message_id.ok_or_else(|| {
        error(
            "stop_message_missing",
            "Delivered BTCC R3 Turn has no canonical message",
        )
    })?;
    Ok(StopPersistenceOutcome::AlreadyDelivered(Box::new(
        AlreadyDeliveredOutcome {
            turn_id: turn_id.to_owned(),
            message_id,
            content: payload.content,
            work_status: payload.work_status,
            accepted_work_result: payload.accepted_work_result,
            runtime_failure: payload.runtime_failure,
            execution_outcome: payload.execution_outcome,
            artifacts: payload.artifacts,
            changed_files: payload.changed_files,
        },
    )))
}

fn cancel(
    connection: &Connection,
    turn_id: &str,
    request_id: &str,
    turn: &ControlRow,
) -> StorageResult<StopPersistenceOutcome> {
    let revision = turn
        .revision
        .checked_add(1)
        .ok_or_else(|| error("turn_revision_overflow", "BTCC Turn revision overflow"))?;
    let changed = connection
        .execute(
            "UPDATE btcc_turns SET semantic_state='cancelled', active_checkpoint_id=NULL, \
         suspension_reason=NULL, revision=?1, execution_fence=execution_fence+1, \
         final_disposition='cancelled' WHERE turn_id=?2 AND revision=?3 \
         AND semantic_state='admitted' AND execution_fence=?4",
            params![revision, turn_id, turn.revision, turn.execution_fence],
        )
        .map_err(StorageError::sqlite)?;
    if changed != 1 {
        return Err(error("stop_cas_lost", "BTCC R3 Stop lost its Turn CAS"));
    }
    connection
        .execute(
            "UPDATE btcc_checkpoints SET is_active=0, active_claim_id=NULL \
         WHERE turn_id=?1 AND is_active=1",
            [turn_id],
        )
        .map_err(StorageError::sqlite)?;
    connection
        .execute(
            "UPDATE btcc_state_claims SET status='revoked' WHERE turn_id=?1 AND status='active'",
            [turn_id],
        )
        .map_err(StorageError::sqlite)?;
    close_stop(connection, request_id, "cancelled", revision)?;
    close_authority(connection, &turn.session_id)?;
    Ok(StopPersistenceOutcome::Cancelled)
}

fn close_stop(
    connection: &Connection,
    request_id: &str,
    status: &str,
    revision: u64,
) -> StorageResult<()> {
    connection
        .execute(
            "UPDATE btcc_stop_requests SET status=?1, observed_turn_revision=?2, \
         updated_at=datetime('now') WHERE stop_request_id=?3",
            params![status, revision, request_id],
        )
        .map_err(StorageError::sqlite)?;
    Ok(())
}

fn close_authority(connection: &Connection, session_id: &str) -> StorageResult<()> {
    let now: String = connection
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })
        .map_err(StorageError::sqlite)?;
    super::authority::close_pending_self_session_requests(
        connection,
        session_id,
        "session_cancelled",
        &now,
    )?;
    Ok(())
}
