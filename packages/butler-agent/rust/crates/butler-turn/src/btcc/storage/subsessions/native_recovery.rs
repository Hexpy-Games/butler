//! Read-only legacy sources reconcile once onto native assignments and delivery.
use super::*;
use crate::btcc::{Child, ChildAssignment};
use butler_work::{cutover, store};

fn context() -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: serde_json::json!({"runtime":"delegation_recovery"}),
    }
}

impl SqliteSubsessionRepository {
    pub(crate) async fn recover_legacy_assignments(&self) -> Result<Vec<Child>, StorageError> {
        let records=self.storage.read(|db| {
            let mut stmt=db.prepare("SELECT d.delegation_id,r.child_session_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.dispatch_state='pending' ORDER BY d.created_at,d.delegation_id").map_err(StorageError::sqlite)?;
            let ids=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(StorageError::sqlite)?.collect::<rusqlite::Result<Vec<_>>>().map_err(StorageError::sqlite)?;
            ids.into_iter().map(|(id,child)| {
                let row=match decode::read(db,"r.child_session_id=?1",&child) {
                    Ok(row)=>row,
                    Err(error) if error.code()==StorageCode::SubsessionPacketInvalid.as_str()=>None,
                    Err(error)=>return Err(error),
                };
                Ok((id,row))
            }).collect::<Result<Vec<_>,StorageError>>()
        }).await?;
        let mut assignments = Vec::new();
        for (id, record) in records {
            if matches!(&record, Some(Child::Assigned(_))) {
                continue;
            }
            if let Some(child) = self
                .storage
                .work_model_write(move |tx| recover(tx, &id, record))
                .await?
            {
                assignments.push(child);
            }
        }
        Ok(assignments)
    }

    pub(crate) async fn recover_legacy_results(&self) -> Result<(), StorageError> {
        let rows=self.storage.read(|db| {
            let mut stmt=db.prepare("SELECT x.child_session_id,x.child_turn_id,x.status,x.summary,x.acceptance_evidence_json,x.created_at FROM btcc_steward_results x WHERE NOT EXISTS(SELECT 1 FROM btcc_subsession_outbox o WHERE o.result_id=x.result_id) ORDER BY x.created_at,x.result_id").map_err(StorageError::sqlite)?;
            stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))
                .map_err(StorageError::sqlite)?.collect::<rusqlite::Result<Vec<_>>>().map_err(StorageError::sqlite)
        }).await?;
        for (session, turn, status, summary, evidence, now) in rows {
            if self.by_child(session.clone()).await?.is_none() {
                continue;
            }
            let evidence_refs = serde_json::from_str(&evidence).map_err(|e| {
                StorageError::new(StorageCode::SubsessionResultInvalid, e.to_string())
                    .with_source(e)
            })?;
            self.commit_result(
                ChildCompletion {
                    session,
                    turn,
                    status,
                    summary,
                    evidence_refs,
                    failure_reason: None,
                    failure_code: None,
                    handoff: None,
                },
                now,
            )
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn unresolved_projection(
        &self,
        session: String,
    ) -> Result<Option<Value>, StorageError> {
        self.storage.read(move |db| db.query_row("SELECT r.relation_id,r.parent_session_id,r.parent_turn_id,r.safe_title,r.created_at,coalesce(r.activity_role,CASE WHEN r.child_session_id LIKE 'worker-%' THEN 'worker' ELSE 'steward' END) FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id JOIN wm_legacy_map m ON m.source='delegation_recovery' AND m.source_id=d.delegation_id WHERE r.child_session_id=?1 AND m.batch='unresolved'",[&session],|r| {
            Ok(serde_json::json!({"session_id":session,"role":r.get::<_,String>(5)?,"status":"failed","terminal":true,"active_turn":null,
                "relation":{"relation_id":r.get::<_,String>(0)?,"parent_session_id":r.get::<_,String>(1)?,"parent_turn_id":r.get::<_,String>(2)?,"safe_title":r.get::<_,String>(3)?,"created_at":r.get::<_,String>(4)?},
                "result":{"status":"failed","summary":"The delegation source could not be restored."},"steward_children":[],"workers":[]}))
        }).optional().map_err(StorageError::sqlite)).await
    }
}

fn recover(
    tx: &store::Transaction<'_>,
    id: &str,
    record: Option<Child>,
) -> store::Result<Option<Child>> {
    let Some(Child::Legacy(mut row)) = record else {
        unresolved(tx, id, "undecodable_packet")?;
        return Ok(None);
    };
    let mapped: Option<String> = tx
        .query_row(
            "SELECT new_id FROM wm_legacy_map WHERE source='delegation' AND source_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(mapped) = mapped else {
        unresolved(tx, id, "unresolvable_root_work")?;
        return Ok(None);
    };
    let task = resolve_task(tx, &mapped)?;
    let Some(task) = task else {
        unresolved(tx, id, "unresolvable_root_work")?;
        return Ok(None);
    };
    if row.dispatch_intent.is_none() {
        unresolved(tx, id, "undecodable_packet")?;
        return Ok(None);
    }
    let task_id = task["id"]
        .as_str()
        .ok_or(store::Error::Invalid("task id"))?
        .to_owned();
    let work_id = task["work_id"]
        .as_str()
        .ok_or(store::Error::Invalid("work id"))?
        .to_owned();
    let attempt_id = format!("attempt-{id}");
    store::assign_task(
        tx,
        &context(),
        &task_id,
        task["revision"]
            .as_i64()
            .ok_or(store::Error::Invalid("revision"))?,
        &store::ExecutionScope {
            session_id: &row.child_session_id,
            turn_id: &row.child_turn_id,
        },
        &attempt_id,
    )?;
    store::tiers::admit(
        tx,
        &context(),
        &row.child_session_id,
        &work_id,
        2,
        "imported delegation",
    )?;
    store::tiers::bind_started_task(tx, &row.child_session_id, &task_id)?;
    row.task_id = task_id.clone();
    row.packet.task_id = task_id.clone();
    row.root_work_id = work_id.clone();
    store::record_intent(
        tx,
        &context(),
        &format!("child_dispatch:{attempt_id}"),
        "child_dispatch",
        &serde_json::json!({"delegation":row}),
    )?;
    Ok(Some(Child::Assigned(ChildAssignment {
        delegation: row,
        work_id,
        task_id,
        part_id: None,
        attempt_id,
    })))
}

fn unresolved(tx: &store::Transaction<'_>, id: &str, code: &str) -> store::Result<()> {
    cutover::needs_source(tx, "delegation", id, code)?;
    tx.execute("INSERT INTO wm_legacy_map(source,source_id,new_id,source_hash,imported_revision,batch) VALUES('delegation_recovery',?1,'','',0,'unresolved') ON CONFLICT(source,source_id) DO NOTHING",[id])?;
    tx.execute("UPDATE btcc_session_relations SET activity_terminal=1 WHERE relation_id=(SELECT relation_id FROM btcc_subsession_delegations WHERE delegation_id=?1)",[id])?;
    Ok(())
}

fn resolve_task(tx: &store::Transaction<'_>, mapped: &str) -> store::Result<Option<Value>> {
    Ok(match store::read_task(tx, &mapped) {
        Ok(task) => Some(task),
        Err(store::Error::NotFound) => {
            let mut stmt=tx.prepare("SELECT id FROM wm_tasks WHERE work_id=?1 AND status IN ('pending','waiting') ORDER BY chain_id,step_index,stack_position LIMIT 2")?;
            let ids = stmt
                .query_map([mapped], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if ids.len() == 1 {
                Some(store::read_task(tx, &ids[0])?)
            } else {
                None
            }
        }
        Err(error) => return Err(error),
    })
}
