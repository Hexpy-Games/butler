use crate::gateway::application::{
    queue::{self, QueuedTurnClaimStatus},
    storage::AppStorageError,
};
use rusqlite::Connection;
use serde_json::Value;

use super::{
    TranscriptEvent,
    values::{object, text, token},
};

/// The status of `claim` for this outbound. The restarted App may have
/// recovered the claim of the crashed process before the restarted service
/// reported the interruption (turn_failed, turn_interrupted); the report
/// then restores and settles that same claim, so the message is not
/// dispatched again.
pub(super) fn current_claim_status(
    db: &Connection,
    chat_id: &str,
    turn_id: &str,
    claim: Option<&str>,
    outbound: &TranscriptEvent,
) -> Result<QueuedTurnClaimStatus, AppStorageError> {
    let status = queue::claim_status(db, chat_id, turn_id, claim)?;
    if matches!(
        status,
        QueuedTurnClaimStatus::Stale | QueuedTurnClaimStatus::Terminal
    ) && cancellation_settlement(db, chat_id, turn_id, outbound)?
    {
        // The owner's durable cancellation authorizes only these terminal
        // authority projections after the suspended queue claim was settled.
        return Ok(QueuedTurnClaimStatus::Unlinked);
    }
    if status == QueuedTurnClaimStatus::Stale && confirmed_owner_stop(db, turn_id, outbound)? {
        // The stale link (input recovered or claimed again after the Stop) no
        // longer fences BTCC's final word; projection ends the turn and that
        // input together (`settle_if_claimed`).
        return Ok(QueuedTurnClaimStatus::Unlinked);
    }
    let metadata = object(outbound.payload.get("metadata"));
    let reply_to = token(object(outbound.payload.get("message")).get("replyToMessageId"));
    if status == QueuedTurnClaimStatus::Stale
        && text(metadata.get("kind")).as_deref() == Some("turn_failed")
        && token(metadata.get("safeErrorCode")).as_deref()
            == Some(crate::gateway::application::retry::INTERRUPTED_TURN_CODE)
        && let (Some(claim), Some(reply_to)) = (claim, reply_to)
        && queue::restore_interrupted_claim(db, chat_id, turn_id, claim, &reply_to)?
    {
        return Ok(QueuedTurnClaimStatus::Current);
    }
    Ok(status)
}

fn cancellation_settlement(
    db: &Connection,
    chat_id: &str,
    turn_id: &str,
    outbound: &TranscriptEvent,
) -> Result<bool, AppStorageError> {
    let metadata = object(outbound.payload.get("metadata"));
    let event = object(metadata.get("event"));
    let payload = object(event.get("payload"));
    if text(metadata.get("kind")).as_deref() != Some("turn_event")
        || !matches!(
            text(event.get("kind")).as_deref(),
            Some("tool.cancelled" | "operation.output.chunk")
        )
        || payload
            .get("authorityCancellation")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM turns t JOIN app_turn_cancel_outbox c ON c.turn_id=t.id \
         WHERE t.id=?1 AND t.chat_id=?2 AND c.state IN ('pending','accepted','completed') AND c.queue_id IS NOT NULL)",
        rusqlite::params![turn_id, chat_id], |row| row.get(0),
    ).map_err(AppStorageError::sqlite)
}

/// BTCC's cancellation of a turn the owner stopped and is still waiting on:
/// BTCC cancelled it or stopped it before admission, so it never runs again.
fn confirmed_owner_stop(
    db: &Connection,
    turn_id: &str,
    outbound: &TranscriptEvent,
) -> Result<bool, AppStorageError> {
    let metadata = object(outbound.payload.get("metadata"));
    if text(metadata.get("kind")).as_deref() != Some("turn_cancelled")
        || !matches!(
            text(metadata.get("outcome")).as_deref(),
            Some("cancelled" | "already_cancelled")
        )
    {
        return Ok(false);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_turn_cancel_outbox \
         WHERE state IN ('pending','accepted') AND turn_id=?1)",
        [turn_id],
        |row| row.get(0),
    )
    .map_err(AppStorageError::sqlite)
}
