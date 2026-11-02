//! Work-indexed Task reads and atomic delegation attachment.
use super::*;
use crate::btcc::{TaskOverlap, WorkTask};
use rusqlite::Connection;

fn encode<T: serde::Serialize>(value: &T) -> Result<String, StorageError> {
    serde_json::to_string(value)
        .map_err(|e| StorageError::new(StorageCode::SubsessionPacketInvalid, e.to_string()))
}

pub(super) fn insert(db: &Connection, input: &SubsessionCreate) -> Result<(), StorageError> {
    let Some(task) = &input.packet.task else {
        return Ok(());
    };
    let Some(parent) = &input.packet.parent_work_ref else {
        return Ok(());
    };
    db.execute("INSERT INTO btcc_work_tasks (task_id,work_id,plan_revision_id,action_key,relation_id,status,scope_json,inputs_json,output_json,overlaps_json,merge_after,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11,?11)",
        params![input.task_id, parent.work_id, parent.plan_revision_id,
            input.packet.plan_action.as_ref().map(|a| &a.action_key), input.relation_id,
            encode(&task.scope)?,encode(&task.inputs)?,encode(&task.output)?,
            encode(&input.packet.task_overlaps)?,encode(&task.merge_after)?,input.created_at])
        .map_err(StorageError::sqlite)?;
    for dependency in task
        .merge_after
        .iter()
        .chain(task.inputs.iter().map(|i| &i.task))
    {
        db.execute(
            "INSERT OR IGNORE INTO btcc_work_task_waits (task_id,after_task_id) VALUES (?1,?2)",
            params![input.task_id, dependency],
        )
        .map_err(StorageError::sqlite)?;
    }
    Ok(())
}

impl SqliteSubsessionRepository {
    pub(crate) async fn task_owner_open(&self, work: String) -> Result<bool, StorageError> {
        self.storage.read(move |db| db.query_row("SELECT EXISTS (SELECT 1 FROM btcc_guided_works WHERE work_id=?1 AND status IN ('open','blocked'))",[work],|r| r.get(0)).map_err(StorageError::sqlite)).await
    }

    /// All ownership records for a single Work, including immutable result refs.
    pub async fn work_tasks(&self, work: String) -> Result<Vec<WorkTask>, StorageError> {
        self.storage.read(move |db| read_tasks(db, &work)).await
    }

    pub(crate) async fn record_task_overlaps(
        &self,
        task: String,
        overlaps: Vec<TaskOverlap>,
    ) -> Result<(), StorageError> {
        self.storage.execute(move |db| {
            let tx = db.transaction().map_err(StorageError::sqlite)?;
            let old: String = tx.query_row("SELECT overlaps_json FROM btcc_work_tasks WHERE task_id=?1", [&task], |r| r.get(0)).map_err(StorageError::sqlite)?;
            let mut all: Vec<TaskOverlap> = serde_json::from_str(&old).map_err(|e| StorageError::new(StorageCode::SubsessionPacketInvalid,e.to_string()))?;
            let previous = all.len();
            for overlap in overlaps { if !all.contains(&overlap) { all.push(overlap); } }
            if all.len()==previous { return Ok(()); }
            tx.execute("UPDATE btcc_work_tasks SET overlaps_json=?2,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE task_id=?1", params![task,encode(&all)?]).map_err(StorageError::sqlite)?;
            tx.commit().map_err(StorageError::sqlite)
        }).await
    }
}

fn json<T: serde::de::DeserializeOwned>(row: &rusqlite::Row<'_>, i: usize) -> rusqlite::Result<T> {
    serde_json::from_str(&row.get::<_, String>(i)?).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(i, rusqlite::types::Type::Text, Box::new(e))
    })
}

pub(super) fn with_scope_errors(
    db: &Connection,
    turn: &str,
    mut summary: String,
) -> Result<String, StorageError> {
    let mut stmt = db.prepare_cached("SELECT e.value FROM btcc_guided_tool_calls c JOIN json_each(c.result_json,'$.task_scope_errors') e WHERE c.turn_id=?1 AND c.status='completed' ORDER BY c.rowid,e.key").map_err(StorageError::sqlite)?;
    for line in stmt
        .query_map([turn], |r| r.get::<_, String>(0))
        .map_err(StorageError::sqlite)?
    {
        summary.push('\n');
        summary.push_str(&line.map_err(StorageError::sqlite)?);
    }
    Ok(summary)
}

/// Keep a queued correction reserved across the closeout of the preceding turn.
pub(super) fn settle_dispatch(
    db: &Connection,
    relation: &str,
    now: &str,
) -> Result<(), StorageError> {
    db.execute("UPDATE btcc_work_tasks SET status='pending',updated_at=?2 WHERE relation_id=?1 AND status IN ('done','cancelled') AND EXISTS (SELECT 1 FROM btcc_guided_works w WHERE w.work_id=btcc_work_tasks.work_id AND w.status IN ('open','blocked')) AND EXISTS (SELECT 1 FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending') AND NOT EXISTS (SELECT 1 FROM btcc_session_relations r JOIN btcc_turns t ON t.turn_id=r.parent_turn_id WHERE r.relation_id=?1 AND t.semantic_state='cancelled')",params![relation,now]).map_err(StorageError::sqlite)?;
    db.execute(super::worker_admission::COMPLETE_WORKER_SQL, [relation])
        .map_err(StorageError::sqlite)?;
    Ok(())
}

fn read_tasks(db: &Connection, work: &str) -> Result<Vec<WorkTask>, StorageError> {
    let mut stmt = db.prepare_cached("SELECT t.task_id,t.work_id,t.plan_revision_id,t.action_key,t.relation_id,t.status,t.scope_json,t.inputs_json,t.output_json,t.overlaps_json,t.merge_after,x.result_id,x.summary FROM btcc_work_tasks t LEFT JOIN btcc_steward_results x ON x.result_id=(SELECT result_id FROM btcc_steward_results WHERE relation_id=t.relation_id ORDER BY rowid DESC LIMIT 1) WHERE t.work_id=?1 ORDER BY t.created_at,t.rowid").map_err(StorageError::sqlite)?;
    stmt.query_map([work], |r| {
        Ok(WorkTask {
            task_id: r.get(0)?,
            work_id: r.get(1)?,
            plan_revision_id: r.get(2)?,
            action_key: r.get(3)?,
            relation_id: r.get(4)?,
            status: r.get(5)?,
            scope: json(r, 6)?,
            inputs: json(r, 7)?,
            output: json(r, 8)?,
            overlaps: json(r, 9)?,
            merge_after: json(r, 10)?,
            result_ref: r.get(11)?,
            summary: r.get(12)?,
        })
    })
    .map_err(StorageError::sqlite)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(StorageError::sqlite)
}

pub(super) fn refresh_packet(
    db: &Connection,
    stored: &mut StoredSubsessionDelegation,
) -> Result<(), StorageError> {
    let Some(parent) = &stored.packet.parent_work_ref else {
        return Ok(());
    };
    let tasks = read_tasks(db, &parent.work_id)?;
    let Some(task) = stored.packet.task.as_mut() else {
        return Ok(());
    };
    if let Some(own) = tasks.iter().find(|t| t.relation_id == stored.relation_id) {
        task.inputs = own.inputs.clone();
        task.merge_after = own.merge_after.clone();
    }
    for id in &task.merge_after {
        if !task.inputs.iter().any(|i| &i.task == id)
            && tasks
                .iter()
                .any(|t| &t.task_id == id && t.status == "done" && t.result_ref.is_some())
        {
            task.inputs.push(crate::btcc::TaskInput {
                task: id.clone(),
                usage: crate::btcc::TaskInputUse::Facts,
                reason: None,
            });
        }
    }
    let inputs = encode(&task.inputs)?;
    stored.packet.task_context = crate::btcc::TaskContract::render_packet(&stored.packet, &tasks);
    if let Some(intent) = stored.dispatch_intent.as_mut() {
        let prompt = stored
            .packet
            .worker_profile
            .as_ref()
            .and_then(|p| p.prompt.as_deref());
        intent.envelope.message.text = stored.packet.render_worker_input(prompt);
    }
    db.execute(
        "UPDATE btcc_work_tasks SET inputs_json=?2 WHERE relation_id=?1 AND inputs_json!=?2",
        params![stored.relation_id, inputs],
    )
    .map_err(StorageError::sqlite)?;
    db.execute("UPDATE btcc_subsession_delegations SET packet_json=?2,dispatch_intent_json=?3 WHERE relation_id=?1",params![stored.relation_id,encode(&stored.packet)?,stored.dispatch_intent.as_ref().map(encode).transpose()?]).map_err(StorageError::sqlite)?;
    Ok(())
}
