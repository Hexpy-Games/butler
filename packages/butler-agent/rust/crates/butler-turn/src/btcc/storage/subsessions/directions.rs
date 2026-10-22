//! Native direction receipts; imported legacy rows are never mutated.
use super::*;
use butler_work::store::{self, control};

pub(crate) fn direction_turn_id(id: &str) -> String {
    format!(
        "subsession-direction-turn-{}",
        &crate::btcc::digest_identity(id)[..32]
    )
}

fn direction(row: &Value, relation: &str) -> StoredSubsessionDirection {
    StoredSubsessionDirection {
        instruction_id: row["id"].as_str().unwrap_or_default().into(),
        relation_id: relation.into(),
        revision: row["received_seq"].as_i64().unwrap_or_default(),
        instruction: row
            .pointer("/content/body/text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .into(),
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}
fn context() -> store::Context {
    store::Context {
        now: chrono::Utc::now().timestamp_millis(),
        actor: serde_json::json!({"runtime":"direction"}),
    }
}
impl SqliteSubsessionRepository {
    pub(crate) async fn create_direction(
        &self,
        relation: String,
        _source_turn: String,
        source_message: String,
        instruction: String,
        _instruction_id: String,
        _now: String,
    ) -> Result<StoredSubsessionDirection, StorageError> {
        let child = self
            .relation_by_id(relation.clone())
            .await?
            .ok_or_else(|| {
                StorageError::new(StorageCode::SubsessionRelationMissing, "Relation missing")
            })?;
        self.storage.work_model_write(move |tx| {
            let epoch = control::epoch(tx, &child.child_session_id)?;
            let key = format!("parent-direction:{relation}:{source_message}");
            let receipt = control::admit(tx, &context(), &control::Instruction {
                target: &child.child_session_id, sender: serde_json::json!({"parent":{"session_id":child.parent_session_id,"relation_id":relation,"relation_epoch":0}}),
                mode: "queue", body: serde_json::json!({"text":instruction}), idempotency_key: &key,
                expected_control_epoch: epoch, anchor_task: &child.task_id })?;
            let rows = control::next_pending(tx, &child.child_session_id, false)?;
            rows.iter().find(|r| r["id"]==receipt["instruction_id"]).map(|r| direction(r,&relation)).ok_or(store::Error::NotFound)
        }).await
    }
    pub(crate) async fn pending_direction(
        &self,
        relation: String,
    ) -> Result<Option<StoredSubsessionDirection>, StorageError> {
        let child = self.relation_by_id(relation.clone()).await?;
        let Some(child) = child else { return Ok(None) };
        self.storage
            .work_model_read(move |db| {
                Ok(control::next_pending(db, &child.child_session_id, false)?
                    .first()
                    .map(|r| direction(r, &relation)))
            })
            .await
    }
    pub(crate) async fn pending_directions(
        &self,
    ) -> Result<Vec<StoredSubsessionDirection>, StorageError> {
        self.storage.work_model_read(move |db| {
            let mut stmt = db.prepare("SELECT DISTINCT r.relation_id,r.child_session_id FROM btcc_session_relations r JOIN wm_instructions i ON i.target_session_id=r.child_session_id WHERE i.status IN ('waiting_for_task','pending_safe_point')")?;
            let ids = stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut pending=Vec::new();
            for (relation,child) in ids { pending.extend(control::next_pending(db,&child,false)?.iter().map(|r|direction(r,&relation))); }
            Ok(pending)
        }).await
    }
    pub(crate) async fn consume_direction(
        &self,
        child: String,
        turn: String,
        _now: String,
    ) -> Result<Option<StoredSubsessionDirection>, StorageError> {
        self.storage
            .work_model_write(move |tx| {
                let relation: Option<String> = tx
                    .query_row(
                        "SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1",
                        [&child],
                        |r| r.get(0),
                    )
                    .optional()?;
                let Some(relation) = relation else {
                    return Ok(None);
                };
                let pending = control::next_pending(tx, &child, false)?;
                let row = pending.iter().find(|r| {
                    r["mode"] == "steer"
                        || direction_turn_id(r["id"].as_str().unwrap_or_default()) == turn
                });
                if let Some(row) = row {
                    let id = row["id"]
                        .as_str()
                        .ok_or(store::Error::Invalid("instruction id"))?;
                    control::mark_delivered(
                        tx,
                        &context(),
                        id,
                        row["status"]
                            .as_str()
                            .ok_or(store::Error::Invalid("status"))?,
                    )?;
                    control::mark_applied(tx, &context(), id)?;
                    return Ok(Some(direction(row, &relation)));
                }
                Ok(None)
            })
            .await
    }
    pub(crate) async fn settle_ended_direction(
        &self,
        child: String,
        id: String,
        _now: String,
    ) -> Result<bool, StorageError> {
        let turn = direction_turn_id(&id);
        if !self.has_turn_result(child, turn).await? {
            return Ok(false);
        }
        self.storage
            .work_model_write(move |tx| {
                for status in ["waiting_for_task", "pending_safe_point"] {
                    control::mark_delivered(tx, &context(), &id, status)?;
                }
                control::mark_applied(tx, &context(), &id)?;
                Ok(true)
            })
            .await
    }
}
