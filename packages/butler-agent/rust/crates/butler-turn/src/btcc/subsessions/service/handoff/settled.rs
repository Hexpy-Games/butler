//! Change-driven acknowledgement also covers Tasks run in a regular chat.
use super::*;
use rusqlite::OptionalExtension;

impl SubsessionService {
    pub async fn reconcile_handoffs(&self) -> Result<(), BtccError> {
        let tasks = self
            .repository
            .storage()
            .work_model_read(|db| {
                let mut stmt = db.prepare(crate::btcc::storage::native_sql::HANDOFF_PENDING)?;
                Ok(stmt
                    .query_map([""], |r| {
                        Ok((
                            r.get::<_, String>("id")?,
                            r.get::<_, String>("assignee_session_id")?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
            .map_err(BtccError::from)?;
        for (task, owner) in tasks {
            if let Some((turn, state)) = self
                .repository
                .latest_turn(owner.clone())
                .await
                .map_err(BtccError::from)?
                && state == "admitted"
                && !self
                    .repository
                    .has_turn_result(owner.clone(), turn)
                    .await
                    .map_err(BtccError::from)?
            {
                continue;
            }
            self.repository.storage().work_model_write(move |tx| {
                let checkpoint: Option<String>=tx.query_row(store::ownership_sql::LATEST_CHECKPOINT,[&task],|r|r.get(0)).optional()?.flatten();
                let checkpoint=match checkpoint {Some(c)=>c,None=>store::put_body(tx,&json!({"task":store::read_task(tx,&task)?,"parts":store::parts::task_parts(tx,&task)?}).to_string())?};
                store::complete_handoff(tx,&admission::context(),&task,&checkpoint)?;
                Ok(())
            }).await.map_err(BtccError::from)?;
        }
        self.drain_task_controls().await
    }
    pub(super) async fn enqueue_handoff_stop(&self, op: &str, p: &Value) -> Result<(), BtccError> {
        let task = p["task_id"].as_str().unwrap_or_default().to_owned();
        let row = self
            .repository
            .storage()
            .work_model_read(move |db| store::read_task(db, &task))
            .await
            .map_err(BtccError::from)?;
        if row["handoff_to_session_id"].is_null() || row["owner_epoch"] != p["owner_epoch"] {
            return Ok(());
        }
        let target = p["session_id"].as_str().unwrap_or_default();
        if let Some(child) = self
            .repository
            .by_child(target.into())
            .await
            .map_err(BtccError::from)?
        {
            Box::pin(self.enqueue_cancel(&child, op)).await?;
        } else if let Some((turn, _)) = self
            .repository
            .latest_turn(target.into())
            .await
            .map_err(BtccError::from)?
        {
            let now = (self.now)();
            self.queue.enqueue(SubsessionEnqueue {envelope:json!({
                "eventId":op,"transport":"app","accountId":"local",
                "peer":{"kind":"dm","id":target},"sender":{"id":"task-ownership","displayName":"Butler"},
                "message":{"id":op,"text":"","timestamp":now},
                "routingHints":{"sessionId":target,"turnId":turn},
                "control":{"kind":"cancel_turn","requestId":op,"turnId":turn,"requestedAt":now}
            }),metadata:Map::new()})?;
        }
        Ok(())
    }
}
