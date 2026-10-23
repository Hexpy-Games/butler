//! Read-only legacy sources reconcile once onto native assignments and delivery.
mod criteria;
pub(crate) mod sql;
use super::*;
use crate::btcc::{Child, ChildAssignment};
use butler_core::json::at;
use butler_work::{cutover, store};

fn context() -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: serde_json::json!({"runtime":"delegation_recovery"}),
    }
}

type LegacyResult = (i64, String, String, String, String, String, String, String);

impl SqliteSubsessionRepository {
    pub(crate) async fn recover_legacy_assignments(&self) -> Result<Vec<Child>, StorageError> {
        let records = self
            .storage
            .read(|db| {
                let mut stmt = db.prepare(sql::RECOVERY_1).map_err(StorageError::sqlite)?;
                let ids = stmt
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                    .map_err(StorageError::sqlite)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(StorageError::sqlite)?;
                ids.into_iter()
                    .map(|(id, child)| {
                        let row = match decode::read(db, "r.child_session_id=?1", &child) {
                            Ok(row) => row,
                            Err(error)
                                if error.code()
                                    == StorageCode::SubsessionPacketInvalid.as_str() =>
                            {
                                None
                            }
                            Err(error) => return Err(error),
                        };
                        Ok((id, row))
                    })
                    .collect::<Result<Vec<_>, StorageError>>()
            })
            .await?;
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
        let mut after = 0;
        loop {
            let rows = self.legacy_results_after(after).await?;
            if rows.is_empty() {
                return Ok(());
            }
            for (rowid, result_id, session, turn, status, summary, evidence, now) in rows {
                after = rowid;
                if self.by_child(session.clone()).await?.is_none() {
                    self.storage
                        .work_model_write(move |tx| {
                            cutover::needs_source(
                                tx,
                                "steward_result",
                                &result_id,
                                "unmapped_result",
                            )?;
                            mark_result(tx, &result_id)
                        })
                        .await?;
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
                self.storage
                    .work_model_write(move |tx| mark_result(tx, &result_id))
                    .await?;
            }
        }
    }

    async fn legacy_results_after(&self, after: i64) -> Result<Vec<LegacyResult>, StorageError> {
        self.storage
            .read(move |db| {
                let mut stmt = db.prepare(sql::RECOVERY_2).map_err(StorageError::sqlite)?;
                stmt.query_map([after], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                })
                .map_err(StorageError::sqlite)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(StorageError::sqlite)
            })
            .await
    }

    pub(crate) async fn unresolved_projection(
        &self,
        session: String,
    ) -> Result<Option<Value>, StorageError> {
        self.storage.read(move |db| db.query_row(sql::RECOVERY_3,[&session],|r| {
            Ok(serde_json::json!({"session_id":session,"role":r.get::<_,String>(5)?,"status":"failed","terminal":true,"active_turn":null,"updated_at":r.get::<_,String>(4)?,
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
        .query_row(sql::RECOVERY_4, [id], |r| r.get(0))
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
    let task = criteria::bind(tx, &row, task)?;
    let task_id = at(&task, "/id")
        .as_str()
        .ok_or(store::Error::Invalid("task id"))?
        .to_owned();
    let work_id = at(&task, "/work_id")
        .as_str()
        .ok_or(store::Error::Invalid("work id"))?
        .to_owned();
    let attempt_id = format!("attempt-{id}");
    let part_id = claim_legacy_part(tx, id, &row, &task, &task_id, &attempt_id)?;
    for session in [&row.parent_session_id, &row.child_session_id] {
        store::tiers::admit(tx, &context(), session, &work_id, 2, "imported delegation")?;
        store::tiers::bind_started_task(tx, session, &task_id)?;
    }
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
    tx.execute(sql::RECOVERY_5, params![id, part_id])?;
    Ok(Some(Child::Assigned(ChildAssignment {
        delegation: row,
        work_id,
        task_id,
        part_id: Some(part_id),
        attempt_id,
    })))
}

fn unresolved(tx: &store::Transaction<'_>, id: &str, code: &str) -> store::Result<()> {
    cutover::needs_source(tx, "delegation", id, code)?;
    tx.execute(sql::RECOVERY_6, [id])?;
    tx.execute(sql::RECOVERY_7, [id])?;
    Ok(())
}

fn resolve_task(tx: &store::Transaction<'_>, mapped: &str) -> store::Result<Option<Value>> {
    Ok(match store::read_task(tx, mapped) {
        Ok(task) => Some(task),
        Err(store::Error::NotFound) => {
            let mut stmt = tx.prepare(sql::RECOVERY_8)?;
            let ids = stmt
                .query_map([mapped], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            match ids.as_slice() {
                [id] => Some(store::read_task(tx, id)?),
                _ => None,
            }
        }
        Err(error) => return Err(error),
    })
}

fn mark_result(tx: &store::Transaction<'_>, id: &str) -> store::Result<()> {
    tx.execute(sql::RECOVERY_9, [id])?;
    Ok(())
}

fn claim_legacy_part(
    tx: &store::Transaction<'_>,
    id: &str,
    row: &crate::btcc::StoredSubsessionDelegation,
    task: &Value,
    task_id: &str,
    attempt_id: &str,
) -> store::Result<String> {
    let ctx = context();
    if !matches!(at(task, "/status").as_str(), Some("running" | "in_review")) {
        store::start_task(
            tx,
            &ctx,
            task_id,
            at(task, "/revision")
                .as_i64()
                .ok_or(store::Error::Invalid("revision"))?,
            &store::ExecutionScope {
                session_id: &row.parent_session_id,
                turn_id: &row.parent_turn_id,
            },
            &format!("parent-{attempt_id}"),
        )?;
    }
    let part_id = format!("part-{id}");
    store::add_part(
        tx,
        &ctx,
        &store::NewPart {
            id: &part_id,
            task_id,
            kind: butler_work::work_types::TaskKind::Execute,
            title: &row.safe_title,
            after_part_ids: &[],
        },
    )?;
    store::assign_part(
        tx,
        &ctx,
        &part_id,
        0,
        &row.parent_session_id,
        &store::ExecutionScope {
            session_id: &row.child_session_id,
            turn_id: &row.child_turn_id,
        },
        attempt_id,
    )?;
    Ok(part_id)
}
