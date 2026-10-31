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
