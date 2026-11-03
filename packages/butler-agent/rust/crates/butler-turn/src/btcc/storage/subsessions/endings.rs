//! Durable intent bridges canonical Work publication and atomic card closeout.
use super::terminal::{close_turn, subtree};
use super::*;

macro_rules! ENDING_SCOPE_SQL {
    ($session:literal) => {
        concat!(
            "WITH RECURSIVE ending_scope(session) AS (SELECT ",
            $session,
            " UNION SELECT r.parent_session_id FROM ending_scope a JOIN btcc_session_relations r
             ON r.child_session_id=a.session)
             SELECT e.session_id,e.turn_id FROM ending_scope a JOIN btcc_subsession_endings e
             ON e.session_id=a.session"
        )
    };
}
pub(super) use ENDING_SCOPE_SQL;

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

    /// Freeze execution before canonical Work closeout and terminal publication.
    pub(crate) async fn prepare_ending(
        &self,
        completion: ChildCompletion,
        now: String,
    ) -> Result<Option<(ChildCompletion, Vec<(String, String)>)>, StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let saved: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM btcc_steward_results WHERE result_id=?1)", [completion::turn_result_id(&completion.session, &completion.turn)], |r| r.get(0)).map_err(StorageError::sqlite)?;
            if saved || !accepts_completion(&tx, &completion.session, &completion.turn)?
                || !ends_card(&tx, &completion.session, &completion.status, Some(&completion.turn))? {
                return Ok(None);
            }
            let encoded = serde_json::to_string(&completion)
                .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
            tx.execute("INSERT OR IGNORE INTO btcc_subsession_endings(session_id,turn_id,completion_json,created_at) VALUES (?1,?2,?3,?4)", params![completion.session,completion.turn,encoded,now]).map_err(StorageError::sqlite)?;
            let mut stopped = Vec::new();
            for session in subtree(&tx, &completion.session)? {
                stopped.extend(fence_session(&tx, &session, &now)?);
            }
            let stored: String = tx.query_row("SELECT completion_json FROM btcc_subsession_endings WHERE session_id=?1", [&completion.session], |r| r.get(0)).map_err(StorageError::sqlite)?;
            let stored = serde_json::from_str(&stored)
                .map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string()))?;
            tx.commit().map_err(StorageError::sqlite)?;
            Ok(Some((stored, stopped)))
        }).await
    }

    pub(crate) async fn ending_in_progress(&self, session: String) -> Result<bool, StorageError> {
        self.storage
            .read(move |db| {
                db.query_row(
                    concat!("SELECT EXISTS(", ENDING_SCOPE_SQL!("?1"), ")"),
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
}

fn fence_session(
    db: &rusqlite::Connection,
    session: &str,
    now: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut turns = db.prepare_cached("SELECT turn_id FROM btcc_turns WHERE session_id=?1 AND semantic_state IN ('admitted','delivery_committed')")
        .map_err(StorageError::sqlite)?.query_map([session], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?;
    let live = turns
        .iter()
        .map(|turn| (session.to_owned(), turn.clone()))
        .collect();
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
    Ok(live)
}

/// The original ending owns completion while its canonical Work is closing.
pub(super) fn accepts_completion(
    db: &rusqlite::Connection,
    session: &str,
    turn: &str,
) -> Result<bool, StorageError> {
    db.query_row(
        concat!("SELECT NOT EXISTS(SELECT 1 FROM btcc_session_relations WHERE child_session_id=?1 AND activity_terminal=1)
         AND NOT EXISTS(SELECT 1 FROM (", ENDING_SCOPE_SQL!("?1"), ") e
         WHERE e.session_id<>?1 OR e.turn_id<>?2)"),
        params![session, turn], |r| r.get(0),
    ).map_err(StorageError::sqlite)
}

pub(super) fn ends_card(
    db: &rusqlite::Connection,
    session: &str,
    status: &str,
    own_turn: Option<&str>,
) -> Result<bool, StorageError> {
    if status != "success" {
        return Ok(true);
    }
    let pending = db.prepare_cached("SELECT i.instruction_id FROM btcc_session_relations r JOIN btcc_subsession_directions i USING(relation_id) WHERE r.child_session_id=?1 AND i.status='pending'")
        .map_err(StorageError::sqlite)?.query_map([session], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>().map_err(StorageError::sqlite)?;
    Ok(!pending
        .iter()
        .any(|id| own_turn != Some(direction_turn_id(id).as_str())))
}
