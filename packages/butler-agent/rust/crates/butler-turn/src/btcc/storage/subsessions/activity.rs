//! Narrow read of the BTCC execution authority used by App relocation admission.

use super::{SqliteSubsessionRepository, StorageError};

impl SqliteSubsessionRepository {
    /// Narrow execution presence for quit/restart. Old waiting display cards
    /// with delivered/cancelled turns are retained but are not live user work.
    pub async fn user_work_present(&self) -> Result<bool, StorageError> {
        self.storage
            .execute(|db| {
                db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM btcc_session_relations r \
                 WHERE r.activity_terminal=0 AND r.activity_role IN ('worker','steward') \
                 AND (COALESCE((SELECT t.semantic_state FROM btcc_turns t \
                       WHERE t.session_id=r.child_session_id ORDER BY t.rowid DESC LIMIT 1), '') \
                      IN ('admitted','delivery_committed') \
                 OR (NOT EXISTS(SELECT 1 FROM btcc_turns t WHERE t.session_id=r.child_session_id) \
                     AND EXISTS(SELECT 1 FROM btcc_subsession_delegations d \
                         WHERE d.relation_id=r.relation_id AND d.dispatch_intent_json IS NOT NULL \
                         AND d.dispatch_state IN ('pending','enqueued')))))",
                    [],
                    |row| row.get(0),
                )
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn has_unfinished_execution(
        &self,
        session: String,
    ) -> Result<bool, StorageError> {
        self.storage
            .execute(move |db| {
                let active: bool = db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM btcc_turns WHERE session_id=?1 AND semantic_state NOT IN ('delivered','cancelled'))",
                        [session],
                        |row| row.get(0),
                    )
                    .map_err(StorageError::sqlite)?;
                Ok(active)
            })
            .await
    }
}

impl SqliteSubsessionRepository {
    /// Activity-only rows in display order; full session/message projections are never read.
    pub async fn activity_page(
        &self,
        history: bool,
        after: Option<(String, String, String)>,
        parent: Option<String>,
        limit: usize,
    ) -> Result<(Vec<serde_json::Value>, Option<(String, String, String)>), StorageError> {
        self.storage.execute(move |db| {
            let mut sql = String::from("SELECT relation_id,created_at,activity_worker_id FROM btcc_session_relations WHERE activity_role IN ('worker','steward')");
            let mut args: Vec<String> = Vec::new();
            if !history { sql.push_str(" AND activity_terminal=0"); }
            if let Some(parent) = parent { sql.push_str(" AND parent_session_id=?"); args.push(parent); }
            if let Some((time,worker,relation)) = after {
                sql.push_str(" AND (created_at<? OR (created_at=? AND (activity_worker_id>? OR (activity_worker_id=? AND relation_id>?))))");
                args.extend([time.clone(),time,worker.clone(),worker,relation]);
            }
            sql.push_str(" ORDER BY created_at DESC,activity_worker_id,relation_id LIMIT ?");
            args.push(limit.clamp(1,200).to_string());
            let candidates=db.prepare_cached(&sql).map_err(StorageError::sqlite)?
                .query_map(rusqlite::params_from_iter(args),|row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?)))
                .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(StorageError::sqlite)?;
            let after=candidates.last().map(|(relation,time,worker)| (time.clone(),worker.clone(),relation.clone()));
            let mut children=Vec::new();
            for (id,_,_) in candidates {
                let relation=match super::decode::read(db,"r.relation_id=?1",&id) {
                    Ok(Some(row)) => row,
                    Ok(None) => continue,
                    Err(error) if error.code()==crate::btcc::StorageCode::SubsessionPacketInvalid.as_str()=>continue,
                    Err(error)=>return Err(error),
                };
                children.push(activity_child(db,&relation)?);
            }
            Ok((children,after))
        }).await
    }
}

fn activity_child(
    db: &rusqlite::Connection,
    r: &super::StoredSubsessionDelegation,
) -> Result<serde_json::Value, StorageError> {
    use rusqlite::OptionalExtension;
    let result: Option<String>=db.query_row("SELECT status FROM btcc_steward_results WHERE relation_id=?1 ORDER BY created_at DESC LIMIT 1",[&r.relation_id],|row|row.get(0)).optional().map_err(StorageError::sqlite)?;
    let latest: Option<String> = db
        .query_row(
            "SELECT semantic_state FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
            [&r.child_session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(StorageError::sqlite)?;
    let status = match result.as_deref() {
        Some("success") => "completed",
        Some("cancelled") => "cancelled",
        Some("blocked") => "blocked",
        Some("failed") => "failed",
        _ if latest.as_deref() == Some("admitted") => "active",
        _ => "waiting",
    };
    Ok(
        serde_json::json!({"role":r.packet.child_role.as_str(),"title":r.safe_title,"status":status,"updated_at":r.created_at,
        "relation":{"relation_id":r.relation_id,"parent_session_id":r.parent_session_id,"parent_turn_id":r.parent_turn_id,"ordinal":r.ordinal,"safe_title":r.safe_title,"created_at":r.created_at},
        "result":result.map(|_|serde_json::json!({"task_id":r.task_id}))}),
    )
}

impl SqliteSubsessionRepository {
    /// Exact cursor identity lookup, so a missing/hidden cursor never scans the inventory.
    pub async fn activity_cursor_parents(
        &self,
        worker: String,
        history: bool,
        parent: Option<String>,
    ) -> Result<Vec<String>, StorageError> {
        self.storage.execute(move |db| {
            let ids=db.prepare_cached("SELECT relation_id FROM btcc_session_relations \
                WHERE activity_worker_id=?1 AND (?2 OR activity_terminal=0) AND (?3 IS NULL OR parent_session_id=?3)")
                .map_err(StorageError::sqlite)?.query_map(rusqlite::params![worker,history,parent],|row|row.get::<_,String>(0))
                .map_err(StorageError::sqlite)?.collect::<Result<Vec<_>,_>>().map_err(StorageError::sqlite)?;
            let mut parents=Vec::new();
            for id in ids {
                match super::decode::read(db,"r.relation_id=?1",&id) {
                    Ok(Some(row))=>parents.push(row.parent_session_id),
                    Ok(None)=>{},
                    Err(error) if error.code()==crate::btcc::StorageCode::SubsessionPacketInvalid.as_str()=>{},
                    Err(error)=>return Err(error),
                }
            }
            parents.sort(); parents.dedup();
            Ok(parents)
        }).await
    }
}

impl SqliteSubsessionRepository {
    /// Indexed descendant execution candidates for visible parents. No messages,
    /// Work plans or historical activity are materialized on the navigation path.
    pub async fn running_descendants(
        &self,
        parents: Vec<String>,
    ) -> Result<Vec<(String, super::StoredSubsessionDelegation)>, StorageError> {
        let parents = serde_json::to_string(&parents).map_err(|error| {
            StorageError::new(
                crate::btcc::StorageCode::SubsessionPacketInvalid,
                error.to_string(),
            )
        })?;
        self.storage
            .execute(move |db| {
                let mut statement = db
                    .prepare_cached(
                        r"WITH RECURSIVE descendants(root,session,relation) AS (
                    SELECT p.value,r.child_session_id,r.relation_id FROM json_each(?1) p
                    JOIN btcc_session_relations r ON r.parent_session_id=p.value
                    WHERE r.activity_terminal=0 AND r.activity_role IN ('steward','worker')
                    UNION
                    SELECT d.root,r.child_session_id,r.relation_id FROM descendants d
                    JOIN btcc_session_relations r ON r.parent_session_id=d.session
                    WHERE r.activity_terminal=0 AND r.activity_role IN ('steward','worker'))
                SELECT root,relation FROM descendants d WHERE
                    (SELECT t.semantic_state FROM btcc_turns t WHERE t.session_id=d.session
                     ORDER BY t.rowid DESC LIMIT 1) IN ('admitted','delivery_committed')",
                    )
                    .map_err(StorageError::sqlite)?;
                let ids = statement
                    .query_map([parents], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(StorageError::sqlite)?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(StorageError::sqlite)?;
                let mut candidates = Vec::new();
                for (parent, id) in ids {
                    match super::decode::read(db, "r.relation_id=?1", &id) {
                        Ok(Some(relation)) => candidates.push((parent, relation)),
                        Ok(None) => {}
                        Err(error)
                            if error.code()
                                == crate::btcc::StorageCode::SubsessionPacketInvalid.as_str() => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(candidates)
            })
            .await
    }
}
