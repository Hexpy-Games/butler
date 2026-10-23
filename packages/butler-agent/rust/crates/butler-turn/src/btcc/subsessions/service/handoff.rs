//! Ownership requests and durable cancellation intents share native execution.
mod settled;
use super::*;
use butler_core::json::at;
use butler_work::store;

impl SubsessionService {
    pub async fn task_ownership(
        &self,
        session: &str,
        task: &str,
        decision: &str,
        expected: i64,
    ) -> Result<Value, BtccError> {
        let to = session.to_owned();
        let task = task.to_owned();
        let decision = decision.to_owned();
        let result = self
            .repository
            .storage()
            .work_model_write(move |tx| {
                let ctx = admission::context();
                if decision == "open" {
                    return store::open_task_session(tx, &ctx, &task);
                }
                if decision != "take_here" {
                    return Err(store::Error::Invalid("ownership decision"));
                }
                let result = store::take_here(tx, &ctx, &task, &to, expected)?;
                store::record_intent(
                    tx,
                    &ctx,
                    &format!("ownership_taken:{task}:{}", at(&result, "/revision")),
                    "ownership_taken",
                    &json!({"task_id":task,"target_session_id":to}),
                )?;
                Ok(result)
            })
            .await;
        let result = match result {
            Ok(result) => result,
            Err(crate::btcc::StorageError::Port {
                source: Some(source),
                ..
            }) if matches!(
                source.downcast_ref::<store::Error>(),
                Some(store::Error::Conflict { .. })
            ) =>
            {
                let revision = match source.downcast_ref::<store::Error>() {
                    Some(store::Error::Conflict { current }) => current["revision"].clone(),
                    _ => Value::Null,
                };
                return Ok(
                    json!({"ok":false,"error":{"code":"conflict","message":"이미 다른 대화로 옮겨졌습니다","revision":revision}}),
                );
            }
            Err(error) => return Err(BtccError::from(error)),
        };
        self.drain_task_controls().await?;
        Ok(result)
    }
    pub async fn drain_task_controls(&self) -> Result<(), BtccError> {
        let intents = self
            .repository
            .storage()
            .work_model_read(|db| {
                let mut stmt = db.prepare(store::ownership_sql::PENDING_CONTROLS)?;
                Ok(stmt
                    .query_map([], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
            .map_err(BtccError::from)?;
        for (op, _kind, payload) in intents {
            let p: Value = serde_json::from_str(&payload)
                .map_err(|e| error(BtccCode::SubsessionIdentityInvalid).with_source(e))?;
            Box::pin(self.enqueue_handoff_stop(&op, &p)).await?;
            self.repository
                .storage()
                .work_model_write(move |tx| {
                    store::acknowledge_intent(tx, &admission::context(), &op)?;
                    Ok(())
                })
                .await
                .map_err(BtccError::from)?;
        }
        Ok(())
    }
    pub(super) async fn recover_handoffs(&self) -> Result<(), BtccError> {
        self.repository.storage().work_model_write(|tx| {
            let tasks = tx.prepare(store::ownership_sql::HANDOFF_PENDING)?.query_map([""],|r|r.get::<_,String>("id"))?.collect::<rusqlite::Result<Vec<_>>>()?;
            for task in tasks {
                use rusqlite::OptionalExtension;
                let checkpoint: Option<String> = tx.query_row(store::ownership_sql::LATEST_CHECKPOINT,[&task],|r|r.get(0)).optional()?.flatten();
                let checkpoint = match checkpoint { Some(c)=>c,None=>store::put_body(tx,"The previous session was interrupted during handoff; inspect the retained Task results before continuing.")? };
                store::complete_handoff(tx,&admission::context(),&task,&checkpoint)?;
            }
            Ok(())
        }).await.map_err(BtccError::from)?;
        self.drain_task_controls().await
    }
}
