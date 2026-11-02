//! Durable intent bridges canonical Work publication and atomic card closeout.
use super::terminal::{close_turn, subtree};
use super::*;

impl SqliteSubsessionRepository {
    /// A late result cannot reopen a terminal or ancestor-fenced assignment.
    pub(crate) async fn accepts_completion(
        &self,
        session: String,
        turn: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| accepts_completion(db, &session, &turn))
            .await
    }

    /// Freeze execution first. The card remains unfinished until canonical Work
    /// closeout succeeds and commit_result publishes its result.
    pub(crate) async fn prepare_ending(
        &self,
        completion: ChildCompletion,
        now: String,
        repair: bool,
    ) -> Result<Option<ChildCompletion>, StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let relation: String = tx.query_row("SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1", [&completion.session], |r| r.get(0)).map_err(StorageError::sqlite)?;
            let saved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE result_id=?1)", [completion::turn_result_id(&completion.session, &completion.turn)], |r| r.get(0)).map_err(StorageError::sqlite)?;
            if saved && !repair { return Ok(None); }
            if !repair && !accepts_completion(&tx, &completion.session, &completion.turn)? { return Ok(None); }
            let pending = tx.prepare_cached("SELECT instruction_id FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'")
                .map_err(StorageError::sqlite)?.query_map([&relation], |r| r.get::<_, String>(0))
                .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?;
            if completion.status == "success" && !repair
                && pending.iter().any(|id| direction_turn_id(id) != completion.turn) { return Ok(None); }
            let stored = stage(&tx, &completion, &now)?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(Some(stored))
        }).await
    }

    pub(crate) async fn ending_in_progress(&self, session: String) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM btcc_subsession_end_members WHERE session_id=?1)",
                    [session],
                    |r| r.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn pending_ending(
        &self,
        session: String,
    ) -> Result<Option<ChildCompletion>, StorageError> {
        self.storage
            .read(move |db| {
                let encoded: Option<String> = db
                    .query_row(
                        "SELECT completion_json FROM btcc_subsession_endings WHERE session_id=?1",
                        [session],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?;
                encoded
                    .map(|raw| {
                        serde_json::from_str(&raw).map_err(|e| {
                            StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string())
                        })
                    })
                    .transpose()
            })
            .await
    }

    pub(crate) async fn pending_endings(&self) -> Result<Vec<ChildCompletion>, StorageError> {
        self.storage
            .read(|db| {
                db.prepare_cached(
                    "SELECT completion_json FROM btcc_subsession_endings ORDER BY created_at",
                )
                .map_err(StorageError::sqlite)?
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(StorageError::sqlite)?
                .map(|raw| {
                    serde_json::from_str(&raw.map_err(StorageError::sqlite)?).map_err(|e| {
                        StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string())
                    })
                })
                .collect()
            })
            .await
    }

    /// Current bindings of all Work that must be closed, including project Work.
    pub(crate) async fn ending_work_turns(
        &self,
        session: String,
    ) -> Result<Vec<String>, StorageError> {
        self.storage.read(move |db| {
            let mut turns = Vec::new();
            for child in subtree(db, &session)? {
                let mut q = db.prepare_cached("SELECT DISTINCT b.turn_id FROM btcc_guided_works w JOIN btcc_guided_turn_work_bindings b ON b.work_id=w.work_id AND b.is_current=1 WHERE w.session_id=?1 AND w.status IN ('open','blocked')").map_err(StorageError::sqlite)?;
                turns.extend(q.query_map([child], |r| r.get::<_, String>(0)).map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?);
            }
            Ok(turns)
        }).await
    }

    pub(crate) async fn pending_terminal_controls(
        &self,
    ) -> Result<Vec<(String, String)>, StorageError> {
        self.storage
            .read(|db| {
                db.prepare_cached(
                    "SELECT session_id,turn_id FROM btcc_subsession_stop_outbox WHERE dispatched=0",
                )
                .map_err(StorageError::sqlite)?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(StorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn terminal_control_dispatched(
        &self,
        turn: String,
    ) -> Result<(), StorageError> {
        self.storage
            .execute(move |db| {
                db.execute(
                    "UPDATE btcc_subsession_stop_outbox SET dispatched=1 WHERE turn_id=?1",
                    [turn],
                )
                .map_err(StorageError::sqlite)?;
                Ok(())
            })
            .await
    }
}

/// Caller owns the transaction, including a failure result saved without a packet.
pub(super) fn stage(
    db: &rusqlite::Connection,
    completion: &ChildCompletion,
    now: &str,
) -> Result<ChildCompletion, StorageError> {
    let encoded = serde_json::to_string(completion)
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
    db.execute("INSERT OR IGNORE INTO btcc_subsession_endings(session_id,completion_json,created_at) VALUES (?1,?2,?3)", params![completion.session,encoded,now]).map_err(StorageError::sqlite)?;
    for session in subtree(db, &completion.session)? {
        fence_session(db, &session, &completion.session, now)?;
    }
    let stored: String = db
        .query_row(
            "SELECT completion_json FROM btcc_subsession_endings WHERE session_id=?1",
            [&completion.session],
            |r| r.get(0),
        )
        .map_err(StorageError::sqlite)?;
    serde_json::from_str(&stored)
        .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))
}

fn fence_session(
    db: &rusqlite::Connection,
    session: &str,
    root: &str,
    now: &str,
) -> Result<(), StorageError> {
    db.execute("INSERT OR IGNORE INTO btcc_subsession_end_members(session_id,root_session_id) VALUES (?1,?2)", params![session,root]).map_err(StorageError::sqlite)?;
    let mut turns = db.prepare_cached("SELECT turn_id FROM btcc_turns WHERE session_id=?1 AND semantic_state IN ('admitted','delivery_committed')")
            .map_err(StorageError::sqlite)?.query_map([session], |r| r.get::<_, String>(0))
            .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?;
    let first: Option<String> = db.query_row("SELECT d.child_turn_id FROM btcc_session_relations r JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.child_session_id=?1", [session], |r| r.get(0)).optional().map_err(StorageError::sqlite)?;
    turns.extend(first);
    let pending = db.prepare_cached("SELECT i.instruction_id FROM btcc_session_relations r JOIN btcc_subsession_directions i USING(relation_id) WHERE r.child_session_id=?1 AND i.status='pending'")
            .map_err(StorageError::sqlite)?.query_map([session], |r| r.get::<_,String>(0))
            .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(StorageError::sqlite)?;
    turns.extend(pending.iter().map(|id| direction_turn_id(id)));
    turns.sort();
    turns.dedup();
    for turn in turns {
        let closed: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND semantic_state IN ('delivered','cancelled'))", [&turn], |r| r.get(0)).map_err(StorageError::sqlite)?;
        if !closed {
            close_turn(db, session, &turn, now)?;
        }
    }
    Ok(())
}

/// The original ending owns completion while its canonical Work is closing.
pub(super) fn accepts_completion(
    db: &rusqlite::Connection,
    session: &str,
    turn: &str,
) -> Result<bool, StorageError> {
    db.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM btcc_session_relations WHERE child_session_id=?1 AND activity_terminal=1)
         AND NOT EXISTS(SELECT 1 FROM btcc_subsession_end_members m JOIN btcc_subsession_endings e ON e.session_id=m.root_session_id
         WHERE m.session_id=?1 AND (e.session_id<>?1 OR json_extract(e.completion_json,'$.turn')<>?2))",
        params![session, turn], |r| r.get(0),
    ).map_err(StorageError::sqlite)
}
