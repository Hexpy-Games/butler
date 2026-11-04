//! Reserve replacement ownership and transfer its pending dependents in one commit.
use super::*;
use crate::btcc::{TaskInput, TaskOverlap};

impl SqliteSubsessionRepository {
    pub(crate) async fn create_replacing(
        &self,
        input: SubsessionCreate,
        old: String,
    ) -> Result<Option<Value>, StorageError> {
        self.storage
            .execute(move |db| {
                let tx = db.transaction().map_err(StorageError::sqlite)?;
                let Some(prior) = read(&tx, "r.relation_id=?1", &old)? else {
                    return Ok(Some(rejected("task_replacement_missing", &old, "missing")));
                };
                let task: Option<(String, String)> = tx
                    .query_row(
                        "SELECT task_id,status FROM btcc_work_tasks WHERE relation_id=?1",
                        [&old],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?;
                let Some((task, status)) = task else {
                    return Ok(Some(rejected("task_replacement_missing", &old, "missing")));
                };
                if !matches!(status.as_str(), "pending" | "active") {
                    return Ok(Some(rejected(
                        "task_replacement_not_running",
                        &task,
                        &status,
                    )));
                }
                if prior.parent_session_id != input.parent_session_id
                    || prior.packet.parent_work_ref.as_ref().map(|p| &p.work_id)
                        != input.packet.parent_work_ref.as_ref().map(|p| &p.work_id)
                {
                    return Ok(Some(rejected(
                        "task_replacement_missing",
                        &task,
                        "not owned",
                    )));
                }
                if handoff::insert(&tx, &input)? {
                    super::handoff_context::supersede_worker(&tx, &old, &input.relation_id)?;
                    transfer_waiters(&tx, &task, &input.task_id)?;
                }
                tx.commit().map_err(StorageError::sqlite)?;
                Ok(None)
            })
            .await
    }
}

fn rejected(code: &str, task: &str, status: &str) -> Value {
    serde_json::json!({"ok":false,"error":{"code":code,"detail":{"task":task,"status":status}}})
}

fn transfer_waiters(db: &rusqlite::Connection, old: &str, new: &str) -> Result<(), StorageError> {
    let mut statement=db.prepare_cached("SELECT t.task_id,t.merge_after,t.inputs_json,t.overlaps_json FROM btcc_work_task_waits d JOIN btcc_work_tasks t ON t.task_id=d.task_id WHERE d.after_task_id=?1 AND t.status='pending' AND t.task_id!=?2").map_err(StorageError::sqlite)?;
    let rows = statement
        .query_map(params![old, new], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(StorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StorageError::sqlite)?;
    for (id, merge, inputs, overlaps) in rows {
        let mut merge: Vec<String> = decode(&merge)?;
        let mut inputs: Vec<TaskInput> = decode(&inputs)?;
        let mut overlaps: Vec<TaskOverlap> = decode(&overlaps)?;
        for dep in &mut merge {
            if dep == old {
                *dep = new.into();
            }
        }
        for input in &mut inputs {
            if input.task == old {
                input.task = new.into();
            }
        }
        let redirected: Vec<_> = overlaps
            .iter()
            .filter(|o| o.task == old)
            .map(|o| {
                let mut o = o.clone();
                o.task = new.into();
                o
            })
            .collect();
        overlaps.extend(redirected);
        db.execute("UPDATE btcc_work_tasks SET merge_after=?2,inputs_json=?3,overlaps_json=?4 WHERE task_id=?1",params![id,encode(&merge)?,encode(&inputs)?,encode(&overlaps)?]).map_err(StorageError::sqlite)?;
        db.execute(
            "DELETE FROM btcc_work_task_waits WHERE task_id=?1 AND after_task_id=?2",
            params![id, old],
        )
        .map_err(StorageError::sqlite)?;
        db.execute(
            "INSERT OR IGNORE INTO btcc_work_task_waits(task_id,after_task_id) VALUES(?1,?2)",
            params![id, new],
        )
        .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, StorageError> {
    serde_json::from_str(raw)
        .map_err(|e| StorageError::new(StorageCode::SubsessionPacketInvalid, e.to_string()))
}
fn encode<T: serde::Serialize>(value: &T) -> Result<String, StorageError> {
    serde_json::to_string(value)
        .map_err(|e| StorageError::new(StorageCode::SubsessionPacketInvalid, e.to_string()))
}
