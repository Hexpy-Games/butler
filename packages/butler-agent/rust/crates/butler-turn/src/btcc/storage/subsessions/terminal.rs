//! Card closeout is one writer transaction, including every descendant runtime.
use super::*;
use rusqlite::Connection;

/// Root first, then only unfinished descendants via the parent/open index.
pub(super) fn subtree(db: &Connection, session: &str) -> Result<Vec<String>, StorageError> {
    db.prepare_cached(
        "WITH RECURSIVE closing(session) AS (SELECT ?1 UNION
         SELECT r.child_session_id FROM closing c JOIN btcc_session_relations r
         ON r.parent_session_id=c.session)
         SELECT session FROM closing",
    )
    .map_err(StorageError::sqlite)?
    .query_map([session], |row| row.get(0))
    .map_err(StorageError::sqlite)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(StorageError::sqlite)
}

/// A saved result is terminal only after its queued continuation is drained.
pub(super) fn close_if_ended(
    db: &Connection,
    session: &str,
    status: &str,
    now: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let pending: bool = db
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM btcc_session_relations r
         JOIN btcc_subsession_directions i USING(relation_id)
         WHERE r.child_session_id=?1 AND i.status='pending')",
            [session],
            |row| row.get(0),
        )
        .map_err(StorageError::sqlite)?;
    if status == "success" && pending {
        return Ok(Vec::new());
    }
    let mut stopped = Vec::new();
    for child in subtree(db, session)?.into_iter().rev() {
        stopped.extend(close_session(db, &child, now)?);
    }
    debug_assert!(
        invariant(db, session)?,
        "terminal delegation has open runtime"
    );
    Ok(stopped)
}

fn close_session(
    db: &Connection,
    session: &str,
    now: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let relation: Option<(String, String, String)> = db
        .query_row(
            "SELECT r.relation_id,d.task_id,d.child_turn_id FROM btcc_session_relations r
         JOIN btcc_subsession_delegations d USING(relation_id) WHERE r.child_session_id=?1",
            [session],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let Some((relation, task, first_turn)) = relation else {
        return Ok(Vec::new());
    };
    let turns = db.prepare_cached(
        "SELECT t.turn_id FROM btcc_turns t WHERE t.session_id=?1 AND (t.semantic_state IN ('admitted','delivery_committed') OR NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.child_session_id=t.session_id AND x.child_turn_id=t.turn_id))",
    ).map_err(StorageError::sqlite)?.query_map([session], |row| row.get::<_, String>(0))
        .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for turn in turns.iter().chain(std::iter::once(&first_turn)) {
        let exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE turn_id=?1)",
                [turn],
                |r| r.get(0),
            )
            .map_err(StorageError::sqlite)?;
        if turns.contains(turn) || !exists {
            close_turn(db, session, turn, now)?;
        }
        db.execute(
            "INSERT OR IGNORE INTO btcc_steward_results
             (result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at)
             VALUES (?1,?2,?3,?4,?5,'cancelled','Parent assignment ended.','[]','[]',?6)",
            params![completion::turn_result_id(session, turn), relation, task, session, turn, now],
        ).map_err(StorageError::sqlite)?;
    }
    super::super::work::close_delegated_session(db, session, now)?;
    db.execute("UPDATE btcc_subsession_directions SET status='applied',applied_at=?2 WHERE relation_id=?1 AND status='pending'", params![relation,now]).map_err(StorageError::sqlite)?;
    db.execute(
        "UPDATE btcc_subsession_delegations SET dispatch_state=NULL WHERE relation_id=?1",
        [&relation],
    )
    .map_err(StorageError::sqlite)?;
    Ok(turns
        .into_iter()
        .map(|turn| (session.into(), turn))
        .collect())
}

/// Fence even an in-flight model/tool result before publishing terminal state.
/// A stop tombstone also prevents a queued first turn from being admitted later.
pub(super) fn close_turn(
    db: &Connection,
    session: &str,
    turn: &str,
    now: &str,
) -> Result<(), StorageError> {
    db.execute(
        "INSERT OR IGNORE INTO btcc_subsession_stop_outbox(turn_id,session_id) VALUES (?1,?2)",
        params![turn, session],
    )
    .map_err(StorageError::sqlite)?;
    db.execute(
        "INSERT OR IGNORE INTO btcc_stop_requests (stop_request_id,turn_id,status,observed_turn_revision,created_at,updated_at)
         VALUES (?1,?2,'cancelled_before_admission',-1,?3,?3)",
        params![crate::btcc::digest_identity(&format!("btcc-stop-request.v1\0{turn}")),turn,now],
    ).map_err(StorageError::sqlite)?;
    db.execute(
        "UPDATE btcc_turns SET semantic_state='cancelled',active_checkpoint_id=NULL,
         authority_continuation_json=NULL,suspension_reason=NULL,revision=revision+1,
         execution_fence=execution_fence+1,final_disposition='cancelled'
         WHERE turn_id=?1 AND semantic_state IN ('admitted','delivery_committed')",
        [turn],
    )
    .map_err(StorageError::sqlite)?;
    db.execute("UPDATE btcc_checkpoints SET is_active=0,active_claim_id=NULL WHERE turn_id=?1 AND is_active=1", [turn]).map_err(StorageError::sqlite)?;
    db.execute(
        "UPDATE btcc_state_claims SET status='revoked' WHERE turn_id=?1 AND status='active'",
        [turn],
    )
    .map_err(StorageError::sqlite)?;
    super::super::authority::close_pending_self_session_requests(
        db,
        session,
        "session_cancelled",
        now,
    )?;
    Ok(())
}

/// Shared by the debug assertion and public stub E2E checks. The Task is the
/// delegation's task_id; its saved result is its durable closing fact.
pub(super) fn invariant(db: &Connection, session: &str) -> Result<bool, StorageError> {
    for child in subtree(db, session)? {
        let open: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM btcc_turns WHERE session_id=?1 AND semantic_state IN ('admitted','delivery_committed'))
             OR EXISTS (SELECT 1 FROM btcc_turns t WHERE t.session_id=?1 AND NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.child_session_id=t.session_id AND x.child_turn_id=t.turn_id))
             OR EXISTS (SELECT 1 FROM btcc_guided_works WHERE session_id=?1 AND status IN ('open','blocked'))
             OR EXISTS (SELECT 1 FROM btcc_session_relations r WHERE r.parent_session_id=?1 AND NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id))

             OR EXISTS (SELECT 1 FROM btcc_session_relations r JOIN btcc_subsession_directions i USING(relation_id) WHERE r.child_session_id=?1 AND i.status='pending')",
            [&child], |row| row.get(0),
        ).map_err(StorageError::sqlite)?;
        if open || !super::super::work::terminal_work_invariant(db, &child)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Check the same closeout invariant used by the writer's debug assertion.
pub fn terminal_card_invariant(db: &Connection, session: &str) -> Result<bool, StorageError> {
    let terminal: bool = db.query_row(
        "SELECT COALESCE((SELECT activity_terminal FROM btcc_session_relations WHERE child_session_id=?1),0)",
        [session], |row| row.get(0),
    ).map_err(StorageError::sqlite)?;
    Ok(!terminal || invariant(db, session)?)
}

impl SqliteSubsessionRepository {
    /// Repair only terminal cards reached from live runtime, not card history.
    pub(crate) async fn terminal_recovery_completions(
        &self,
    ) -> Result<Vec<ChildCompletion>, StorageError> {
        self.storage.execute(move |db| {
            let sessions = db.prepare_cached(
                "WITH RECURSIVE live(session) AS (
                    SELECT session_id FROM btcc_turns WHERE semantic_state IN ('admitted','delivery_committed')
                    UNION SELECT session_id FROM btcc_guided_works WHERE status IN ('open','blocked')
                    UNION SELECT r.child_session_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) WHERE d.dispatch_state IN ('pending','enqueued')
                 ), ancestors(session) AS (
                    SELECT session FROM live UNION SELECT r.parent_session_id FROM ancestors a
                    JOIN btcc_session_relations r ON r.child_session_id=a.session)
                 SELECT r.child_session_id FROM ancestors a JOIN btcc_session_relations r
                 ON r.child_session_id=a.session WHERE r.activity_terminal=1",
            ).map_err(StorageError::sqlite)?.query_map([], |row| row.get::<_, String>(0))
                .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>, _>>()
                .map_err(StorageError::sqlite)?;
            let mut completions = Vec::new();
            for session in sessions {
                let completion = db.query_row(
                    "SELECT child_turn_id,status,summary,acceptance_evidence_json FROM btcc_steward_results WHERE child_session_id=?1 ORDER BY rowid DESC LIMIT 1",
                    [&session], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?,r.get::<_, String>(3)?)),
                ).optional().map_err(StorageError::sqlite)?;
                if let Some((turn,status,summary,evidence)) = completion {
                    completions.push(ChildCompletion { session, turn, status, summary,
                        failure_reason: None, failure_code: None, handoff: None,
                        evidence_refs: serde_json::from_str(&evidence).map_err(|e| StorageError::new(StorageCode::SubsessionResultInvalid,e.to_string()))? });
                }
            }
            Ok(completions)
        }).await
    }
}
