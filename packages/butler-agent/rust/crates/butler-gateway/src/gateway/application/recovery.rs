//! Exact-claim dispatch recovery outside the admission service.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use super::*;

impl AppApplication {
    /// Keep the linked Turn/message identity, but release only this admission's
    /// exact claim. A queued link is excluded from active-turn gating on restart.
    pub(super) async fn park_dispatch(
        &self,
        claim: &QueueClaim,
    ) -> Result<(), GatewayApplicationError> {
        let claim = claim.clone();
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage.execute(move |db| {
            let tx = db.savepoint().map_err(AppStorageError::sqlite)?;
            let changed = tx.execute("UPDATE session_queued_messages SET state='queued',safe_error_code=NULL,claim_id=NULL,claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=?1 WHERE id=?2 AND chat_id=?3 AND state='dispatching' AND claim_id=?4",
                params![now,claim.queued_message_id,claim.chat_id,claim.claim_id]).map_err(AppStorageError::sqlite)?;
            if changed == 1 {
                events::append(&tx, &subscribers, "session_queue.changed", None,
                    service::map(&json!({"session_id":claim.chat_id,"queued_message_id":claim.queued_message_id,"action":"recovered","recovery_reason":"service_stopping"}))?, &now)?;
            }
            tx.commit().map_err(AppStorageError::sqlite)
        }).await.map_err(app_error)
    }

    pub(super) async fn recover_expired(&self) -> Result<(), GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let rows = self
            .storage
            .read(dispatching_claims)
            .await
            .map_err(app_error)?;
        for row in rows {
            let expired = row
                .lease_expires_at
                .as_deref()
                .is_none_or(|lease| lease <= now.as_str());
            let dead = row.claim_owner.as_deref().is_some_and(|owner| {
                self.dependencies
                    .queue_owner_liveness
                    .definitely_dead(owner, &self.queue_owner)
            });
            let retained = if let Some(turn) = &row.turn_id {
                self.dependencies
                    .approval_claims
                    .retains_claim(turn.clone())
                    .await?
            } else {
                false
            };
            if (!expired && !dead) || retained || self.adopt_native(&row, &now).await? {
                continue;
            }
            let timestamp = now.clone();
            let subscribers = self.subscribers.clone();
            self.storage
                .execute(move |db| recover_one(db, &row, &timestamp, &subscribers))
                .await
                .map_err(app_error)?;
        }
        Ok(())
    }

    /// A dispatch whose durable native record can still deliver keeps the
    /// claim that record carries, now owned here. Only a dispatch that never
    /// reached the native queue (or whose record failed) is queued again:
    /// a new claim for a surviving record would run the message twice and
    /// fence the surviving record's result out of the turn.
    async fn adopt_native(
        &self,
        row: &ExpiredClaim,
        now: &str,
    ) -> Result<bool, GatewayApplicationError> {
        if row.turn_id.is_none() {
            return Ok(false);
        }
        let (id, prior) = (row.id.clone(), row.claim_id.clone());
        let dispatched = self
            .storage
            .read(move |db| dispatched_attempt(db, &id, prior.as_deref()))
            .await
            .map_err(app_error)?;
        let Some((message_id, attempt)) = dispatched else {
            return Ok(false);
        };
        let Some(claim) = self
            .dependencies
            .native_ingress
            .delivering_claim(message_id, attempt, row.claim_id.clone())
            .await?
        else {
            return Ok(false);
        };
        let lease = self
            .dependencies
            .identity_clock
            .iso_after_millis(super::queue::SESSION_QUEUE_LEASE_MILLIS as u64);
        let (id, prior, owner, now) = (
            row.id.clone(),
            row.claim_id.clone(),
            self.queue_owner.clone(),
            now.to_owned(),
        );
        self.storage
            .execute(move |db| {
                db.execute_cached(ADOPT_SQL, params![claim, owner, lease, now, id, prior])
                    .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        Ok(true)
    }
}

/// Unchanged since read: a concurrent settlement or claim wins.
const ADOPT_SQL: &str = "UPDATE session_queued_messages SET claim_id=?1,claim_owner=?2,\
    lease_expires_at=?3,updated_at=?4 WHERE id=?5 AND state='dispatching' AND claim_id IS ?6";

/// The App message and attempt a linked dispatch handed to the native queue.
fn dispatched_attempt(
    db: &Connection,
    id: &str,
    claim: Option<&str>,
) -> Result<Option<(String, u64)>, AppStorageError> {
    db.query_row_cached(
        "SELECT q.dispatched_message_id,t.attempt FROM session_queued_messages q \
         JOIN turns t ON t.id=q.turn_id \
         WHERE q.id=?1 AND q.state='dispatching' AND q.claim_id IS ?2",
        params![id, claim],
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, u64>(1)?)),
    )
    .optional()
    .map_err(AppStorageError::sqlite)
    .map(|row| row.and_then(|(message, attempt)| Some((message?, attempt))))
}

struct ExpiredClaim {
    id: String,
    claim_id: Option<String>,
    turn_id: Option<String>,
    chat_id: String,
    claim_owner: Option<String>,
    lease_expires_at: Option<String>,
}
/// The `state IN` term repeats the predicate of the partial
/// `session_queued_messages_active_idx`, which makes it applicable.
pub(super) const DISPATCHING_SQL: &str = "SELECT id,claim_id,turn_id,chat_id,claim_owner,\
    lease_expires_at FROM session_queued_messages \
    WHERE state='dispatching' AND state IN ('queued','dispatching') ORDER BY rowid";

fn dispatching_claims(db: &Connection) -> Result<Vec<ExpiredClaim>, AppStorageError> {
    let mut statement = db
        .prepare_cached(DISPATCHING_SQL)
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([], |row| {
            Ok(ExpiredClaim {
                id: row.get(0)?,
                claim_id: row.get(1)?,
                turn_id: row.get(2)?,
                chat_id: row.get(3)?,
                claim_owner: row.get(4)?,
                lease_expires_at: row.get(5)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}
fn recover_one(
    db: &Connection,
    row: &ExpiredClaim,
    now: &str,
    subscribers: &EventSubscribers,
) -> Result<(), AppStorageError> {
    let changed=db.execute_cached("UPDATE session_queued_messages SET state='queued',claim_id=NULL,claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=?1 WHERE id=?2 AND state='dispatching' AND claim_id IS ?3",params![now,row.id,row.claim_id]).map_err(AppStorageError::sqlite)?;
    if changed == 1 {
        events::append(
            db,
            subscribers,
            "session_queue.changed",
            row.turn_id.as_deref(),
            service::map(
                &json!({"session_id":row.chat_id,"queued_message_id":row.id,"action":"recovered","recovery_reason":"dispatch_lease_expired"}),
            )?,
            now,
        )?;
    }
    Ok(())
}
