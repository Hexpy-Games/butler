//! Durable App admission queue and exact-claim transitions.

use rusqlite::{Connection, OptionalExtension, params};

use super::{events, events::EventSubscribers, service, storage::AppStorageError};
use crate::gateway::application::storage::AppStorageCode;

pub(super) const SESSION_QUEUE_LEASE_MILLIS: i64 = 60_000;

#[derive(Clone, Debug)]
pub(super) struct QueueReservation {
    pub id: String,
    pub chat_id: String,
    pub text: String,
    pub client_message_id: String,
    pub input_identity_digest: String,
    pub control_resolution_json: String,
    pub controls_json: String,
    pub attachments_json: String,
    pub content_parts_json: Option<String>,
    pub project_source_refs_json: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct QueueClaim {
    pub queued_message_id: String,
    pub chat_id: String,
    pub claim_id: String,
    pub claim_owner: String,
    pub lease_expires_at: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum QueuedTurnClaimStatus {
    Unlinked,
    Current,
    Terminal,
    Stale,
}

pub(super) fn existing_control_resolution(
    connection: &Connection,
    chat_id: &str,
    client_message_id: &str,
    input_identity_digest: &str,
) -> Result<Option<String>, AppStorageError> {
    let existing = connection
        .query_row(
            "SELECT input_identity_digest,control_resolution_json FROM session_queued_messages \
             WHERE chat_id=?1 AND client_message_id=?2",
            params![chat_id, client_message_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let Some((digest, resolution)) = existing else {
        return Ok(None);
    };
    if digest.as_deref() != Some(input_identity_digest) {
        return Err(AppStorageError::new(
            AppStorageCode::QueuedMessageIdentityConflict,
            "This client message id was already accepted with different input.",
        ));
    }
    resolution.map(Some).ok_or_else(|| {
        AppStorageError::new(
            AppStorageCode::TurnControlResolutionInvalid,
            "Turn controls are unavailable.",
        )
    })
}

/// Pauses the session's queue after the user stopped `turn_id`.
pub(super) fn pause(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    now: &str,
) -> Result<(), AppStorageError> {
    connection
        .execute(
            "INSERT INTO session_queue_pauses(chat_id,turn_id,created_at) VALUES(?1,?2,?3) \
             ON CONFLICT(chat_id) DO UPDATE SET turn_id=excluded.turn_id,created_at=excluded.created_at",
            params![chat_id, turn_id, now],
        )
        .map_err(AppStorageError::sqlite)?;
    Ok(())
}

pub(super) fn reserve(
    connection: &Connection,
    input: &QueueReservation,
) -> Result<bool, AppStorageError> {
    let existing = connection
        .query_row(
            "SELECT input_identity_digest FROM session_queued_messages \
             WHERE chat_id = ?1 AND client_message_id = ?2",
            params![input.chat_id, input.client_message_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    if let Some(existing_digest) = existing {
        if existing_digest.as_deref() == Some(input.input_identity_digest.as_str()) {
            return Ok(false);
        }
        return Err(AppStorageError::new(
            AppStorageCode::QueuedMessageIdentityConflict,
            "This client message id was already accepted with different input.",
        ));
    }
    connection
        .execute(
            "INSERT INTO session_queued_messages (\
               id, chat_id, text, client_message_id, input_identity_digest, \
               control_resolution_json, controls_json, attachments_json, content_parts_json, \
               project_source_refs_json, state, safe_error_code, dispatched_message_id, turn_id, \
               claim_id, claim_owner, claimed_at, lease_expires_at, terminal_result_message_id, \
               created_at, updated_at\
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'queued',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?11,?11)",
            params![
                input.id,
                input.chat_id,
                input.text,
                input.client_message_id,
                input.input_identity_digest,
                input.control_resolution_json,
                input.controls_json,
                input.attachments_json,
                input.content_parts_json,
                input.project_source_refs_json,
                input.created_at,
            ],
        )
        .map_err(AppStorageError::sqlite)?;
    // New user input resumes a queue paused by Stop.
    connection
        .execute(
            "DELETE FROM session_queue_pauses WHERE chat_id=?1",
            [&input.chat_id],
        )
        .map_err(AppStorageError::sqlite)?;
    Ok(true)
}

pub(super) fn claim(
    connection: &Connection,
    claim: &QueueClaim,
    claimed_at: &str,
    subscribers: &EventSubscribers,
) -> Result<Option<QueueClaim>, AppStorageError> {
    let changed = connection
        .execute(
            "UPDATE session_queued_messages SET state='dispatching', claim_id=?1, \
               claim_owner=?2, claimed_at=?3, lease_expires_at=?4, updated_at=?3 \
             WHERE id=?5 AND chat_id=?6 AND state='queued' AND NOT EXISTS (\
               SELECT 1 FROM session_queued_messages active \
               WHERE active.chat_id=?6 AND active.state='dispatching')",
            params![
                claim.claim_id,
                claim.claim_owner,
                claimed_at,
                claim.lease_expires_at,
                claim.queued_message_id,
                claim.chat_id
            ],
        )
        .map_err(AppStorageError::sqlite)?;
    if changed == 1 {
        events::append(
            connection,
            subscribers,
            "session_queue.changed",
            None,
            service::map(&serde_json::json!({
                "session_id":claim.chat_id,
                "queued_message_id":claim.queued_message_id,
                "action":"dispatching",
                "lease_expires_at":claim.lease_expires_at
            }))?,
            claimed_at,
        )?;
    }
    Ok((changed == 1).then(|| claim.clone()))
}

pub(super) fn link_dispatch(
    connection: &Connection,
    claim: &QueueClaim,
    message_id: &str,
    turn_id: &str,
    updated_at: &str,
) -> Result<bool, AppStorageError> {
    let changed = connection
        .execute(
            "UPDATE session_queued_messages SET dispatched_message_id=?1, turn_id=?2, updated_at=?3 \
             WHERE id=?4 AND chat_id=?5 AND state='dispatching' AND claim_id=?6",
            params![
                message_id,
                turn_id,
                updated_at,
                claim.queued_message_id,
                claim.chat_id,
                claim.claim_id
            ],
        )
        .map_err(AppStorageError::sqlite)?;
    Ok(changed == 1)
}

pub(super) fn claim_status(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    claim_id: Option<&str>,
) -> Result<QueuedTurnClaimStatus, AppStorageError> {
    let row = connection
        .query_row(
            "SELECT state, claim_id FROM session_queued_messages \
             WHERE chat_id=?1 AND turn_id=?2 ORDER BY rowid DESC LIMIT 1",
            params![chat_id, turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    Ok(match row {
        None => QueuedTurnClaimStatus::Unlinked,
        Some((state, _)) if matches!(state.as_str(), "dispatched" | "failed") => {
            QueuedTurnClaimStatus::Terminal
        }
        Some((state, current))
            if state == "dispatching"
                && current.as_deref().is_some_and(|id| Some(id) == claim_id) =>
        {
            QueuedTurnClaimStatus::Current
        }
        Some(_) => QueuedTurnClaimStatus::Stale,
    })
}

pub(super) fn fence(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    claim_id: &str,
) -> Result<bool, AppStorageError> {
    connection
        .execute(
            "UPDATE session_queued_messages SET updated_at=updated_at \
             WHERE chat_id=?1 AND turn_id=?2 AND state='dispatching' AND claim_id=?3",
            params![chat_id, turn_id, claim_id],
        )
        .map(|changed| changed == 1)
        .map_err(AppStorageError::sqlite)
}

/// Restore only a claim whose already-delivered final result survived lease recovery.
/// The recovery event and unchanged timestamp prove that the queued input has not
/// been edited, cancelled, or claimed again since the original dispatch.
/// Which terminal outbound restores a claim the App recovered.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ClaimRestore {
    /// A delivered final result of a turn that is still thinking.
    DeliveredFinal,
    /// A crash interruption report of a turn in any running state
    /// (accepted, thinking or retrying).
    Interruption,
}

/// Restores the recovered claim a delivered final result settles.
pub(super) fn restore_delivered_claim(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    original_claim: &str,
    reply_to_message_id: &str,
) -> Result<bool, AppStorageError> {
    restore_claim(
        connection,
        chat_id,
        turn_id,
        original_claim,
        reply_to_message_id,
        ClaimRestore::DeliveredFinal,
    )
}

/// Restores the recovered claim a crash interruption report settles.
pub(super) fn restore_interrupted_claim(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    original_claim: &str,
    reply_to_message_id: &str,
) -> Result<bool, AppStorageError> {
    restore_claim(
        connection,
        chat_id,
        turn_id,
        original_claim,
        reply_to_message_id,
        ClaimRestore::Interruption,
    )
}

fn restore_claim(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    original_claim: &str,
    reply_to_message_id: &str,
    restore: ClaimRestore,
) -> Result<bool, AppStorageError> {
    connection
        .execute(
            "UPDATE session_queued_messages SET state='dispatching',claim_id=?1 \
             WHERE chat_id=?2 AND turn_id=?3 AND state='queued' AND claim_id IS NULL \
               AND claim_owner IS NULL AND lease_expires_at IS NULL \
               AND terminal_result_message_id IS NULL AND dispatched_message_id=?4 \
               AND input_identity_digest IS NOT NULL AND input_identity_digest<>'' \
               AND EXISTS (SELECT 1 FROM turns t JOIN messages m ON m.id=t.user_message_id \
                 WHERE t.id=?3 AND t.chat_id=?2 \
                   AND (t.state='thinking' OR (?5=1 AND t.state IN ('accepted','retrying'))) \
                   AND m.id=?4 AND m.chat_id=?2 AND m.role='user' AND m.status='sent' \
                   AND m.text=session_queued_messages.text \
                   AND m.content_parts_json IS session_queued_messages.content_parts_json) \
               AND EXISTS (SELECT 1 FROM events e \
                 WHERE e.turn_id=?3 AND e.type='session_queue.changed' \
                   AND e.created_at=session_queued_messages.updated_at \
                   AND json_extract(e.payload_json,'$.queued_message_id')=session_queued_messages.id \
                   AND json_extract(e.payload_json,'$.action')='recovered' \
                   AND json_extract(e.payload_json,'$.recovery_reason')='dispatch_lease_expired')",
            params![
                original_claim,
                chat_id,
                turn_id,
                reply_to_message_id,
                restore == ClaimRestore::Interruption
            ],
        )
        .map(|changed| changed == 1)
        .map_err(AppStorageError::sqlite)
}

pub(super) fn settle(
    connection: &Connection,
    chat_id: &str,
    turn_id: &str,
    claim_id: &str,
    result_message_id: Option<&str>,
    safe_error_code: Option<&str>,
    updated_at: &str,
) -> Result<bool, AppStorageError> {
    let state = if safe_error_code.is_some() {
        "failed"
    } else {
        "dispatched"
    };
    connection
        .execute(
            "UPDATE session_queued_messages SET state=?1, terminal_result_message_id=?2, \
               safe_error_code=?3, claim_id=NULL, claim_owner=NULL, claimed_at=NULL, \
               lease_expires_at=NULL, updated_at=?4 \
             WHERE chat_id=?5 AND turn_id=?6 AND state='dispatching' AND claim_id=?7",
            params![
                state,
                result_message_id,
                safe_error_code,
                updated_at,
                chat_id,
                turn_id,
                claim_id
            ],
        )
        .map(|changed| changed == 1)
        .map_err(AppStorageError::sqlite)
}
