//! A direction settles with the child turn that was started to continue it.

use super::*;

/// The child turn that continues a subsession with one direction.
pub(crate) fn direction_turn_id(instruction_id: &str) -> String {
    format!(
        "subsession-direction-turn-{}",
        &crate::btcc::digest_identity(instruction_id)[..32]
    )
}

const SETTLE: &str = "UPDATE btcc_subsession_directions SET status='applied',applied_at=?2,applied_child_turn_id=?3 WHERE instruction_id=?1 AND status='pending'";

/// A continuation's saved result settles the direction it was started for,
/// even when the turn ended before a model round took it: the parent has the
/// turn's result, the direction never runs again, and the next one can.
pub(super) fn settle_continued_direction(
    tx: &rusqlite::Transaction<'_>,
    relation: &str,
    turn: &str,
    now: &str,
) -> Result<(), StorageError> {
    let mut statement = tx
        .prepare(
            "SELECT instruction_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
        )
        .map_err(StorageError::sqlite)?;
    let pending: Vec<String> = statement
        .query_map([relation], |row| row.get(0))
        .map_err(StorageError::sqlite)?
        .collect::<Result<_, _>>()
        .map_err(StorageError::sqlite)?;
    if let Some(id) = pending.iter().find(|id| direction_turn_id(id) == turn) {
        tx.execute(SETTLE, params![id, now, turn])
            .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

/// Stopping a Steward also stops what it was still told to do: nothing takes
/// these directions up again, even after a restart.
pub(super) fn retire_with_stop(
    tx: &rusqlite::Transaction<'_>,
    relation: &str,
    turn: &str,
    now: &str,
) -> Result<(), StorageError> {
    tx.execute(
        "UPDATE btcc_subsession_directions SET status='applied',applied_at=?2,applied_child_turn_id=?3 WHERE relation_id=?1 AND status='pending'",
        params![relation, now, turn],
    )
    .map_err(StorageError::sqlite)?;
    Ok(())
}

impl SqliteSubsessionRepository {
    /// The relation following a Work, or the one that ran it earlier in its
    /// child session: a parent can still hold a Work its relation moved past.
    pub(crate) async fn relation_by_work(
        &self,
        work: String,
    ) -> Result<Option<StoredSubsessionDelegation>, StorageError> {
        self.storage
            .execute(move |db| {
                if let Some(relation) = read(db, "d.root_work_id=?1", &work)? {
                    return Ok(Some(relation));
                }
                let session: Option<String> = db
                    .query_row(
                        "SELECT session_id FROM btcc_guided_works WHERE work_id=?1",
                        [&work],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?;
                match session {
                    Some(session) => read(db, "r.child_session_id=?1", &session),
                    None => Ok(None),
                }
            })
            .await
    }

    /// Moves a relation to the Work a direction runs on. Every reader of the
    /// relation's Work then sees the current one; earlier Work keeps its session.
    pub(crate) async fn follow_work(
        &self,
        relation: String,
        work: String,
    ) -> Result<(), StorageError> {
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE btcc_subsession_delegations SET root_work_id=?2 WHERE relation_id=?1",
                    params![relation, work],
                )
                .map_err(StorageError::sqlite)?;
                Ok(())
            })
            .await
    }

    /// Retires a relation's waiting directions and returns the turn the first
    /// would have run in, for a stop that arrives before that turn starts.
    pub(crate) async fn has_pending_direction(
        &self,
        relation: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(
                    "SELECT EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending')",
                    [relation],
                    |row| row.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn retire_pending_directions(
        &self,
        relation: String,
        now: String,
    ) -> Result<Option<String>, StorageError> {
        self.storage
            .execute(move |db| {
                let tx = db.transaction().map_err(StorageError::sqlite)?;
                let first: Option<String> = tx
                    .query_row(
                        "SELECT instruction_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending' ORDER BY revision LIMIT 1",
                        [&relation],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?;
                let turn = first.as_deref().map(direction_turn_id);
                if let Some(turn) = &turn {
                    retire_with_stop(&tx, &relation, turn, &now)?;
                }
                tx.commit().map_err(StorageError::sqlite)?;
                Ok(turn)
            })
            .await
    }

    /// Settles a pending direction whose continuation turn already has a saved
    /// result (left by a closeout saved before directions settled with their
    /// continuation). Returns whether it was settled.
    pub(crate) async fn settle_ended_direction(
        &self,
        child: String,
        instruction_id: String,
        now: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .execute(move |db| {
                let turn = direction_turn_id(&instruction_id);
                let ended = db
                    .query_row(
                        "SELECT 1 FROM btcc_steward_results WHERE result_id=?1",
                        [super::completion::turn_result_id(&child, &turn)],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?
                    .is_some();
                if !ended {
                    return Ok(false);
                }
                let settled = db
                    .execute(SETTLE, params![instruction_id, now, turn])
                    .map_err(StorageError::sqlite)?;
                Ok(settled == 1)
            })
            .await
    }
}
