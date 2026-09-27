//! Exact-claim dispatch recovery outside the admission service.

use rusqlite::{Connection, params};
use serde_json::json;

use super::*;

impl AppApplication {
    pub(super) async fn recover_expired(&self) -> Result<(), GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let rows = self
            .storage
            .execute(dispatching_claims)
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
            if (!expired && !dead) || retained {
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
}

struct ExpiredClaim {
    id: String,
    claim_id: Option<String>,
    turn_id: Option<String>,
    chat_id: String,
    claim_owner: Option<String>,
    lease_expires_at: Option<String>,
}
fn dispatching_claims(db: &mut Connection) -> Result<Vec<ExpiredClaim>, AppStorageError> {
    let mut statement=db.prepare("SELECT id,claim_id,turn_id,chat_id,claim_owner,lease_expires_at FROM session_queued_messages WHERE state='dispatching' ORDER BY rowid").map_err(AppStorageError::sqlite)?;
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
    let changed=db.execute("UPDATE session_queued_messages SET state='queued',claim_id=NULL,claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=?1 WHERE id=?2 AND state='dispatching' AND claim_id IS ?3",params![now,row.id,row.claim_id]).map_err(AppStorageError::sqlite)?;
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
