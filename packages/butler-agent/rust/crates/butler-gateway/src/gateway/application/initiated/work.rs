//! Durable completion turns use the same queue and idempotency key as immediate results.
use super::{super::*, gate::Hold, outbox};
use crate::gateway::{GatewayApplication, MessageSendRequest, SendMessageCommand};
use rusqlite::params;
use serde_json::{Value, json};

#[derive(serde::Serialize, serde::Deserialize)]
struct HeldResult {
    text: Option<Value>,
    client_message_id: Option<Value>,
    model: Option<Value>,
    reasoning_effort: Option<Value>,
    subsession_result: Option<butler_turn::btcc::SubsessionResultContext>,
    schedule_run: Option<butler_turn::btcc::ScheduleRunContext>,
}
impl From<MessageSendRequest> for HeldResult {
    fn from(r: MessageSendRequest) -> Self {
        Self {
            text: r.text,
            client_message_id: r.client_message_id,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
            subsession_result: r.subsession_result,
            schedule_run: r.schedule_run,
        }
    }
}
impl From<HeldResult> for MessageSendRequest {
    fn from(r: HeldResult) -> Self {
        Self {
            text: r.text,
            client_message_id: r.client_message_id,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
            subsession_result: r.subsession_result,
            schedule_run: r.schedule_run,
            ..Self::default()
        }
    }
}

impl AppApplication {
    pub(crate) async fn subsession_result_owned(
        &self,
        command: SendMessageCommand,
    ) -> Result<Value, GatewayApplicationError> {
        let mut command = command;
        command.request.schedule_run = command
            .request
            .schedule_run
            .filter(|r| r.unattended || r.connector_event);
        if command.chat_id != "general" {
            command.request.access_mode = Some(self.result_access(&command).await?);
            return serde_json::to_value(self.send_message(command).await?)
                .map_err(GatewayApplicationError::internal_from);
        }
        let bypass = command.request.schedule_run.is_none();
        let context = command
            .request
            .subsession_result
            .as_ref()
            .ok_or_else(GatewayApplicationError::internal)?;
        let source = format!("work-result:{}:{}", context.relation_id, context.result_id);
        let title = context.safe_title.clone();
        let payload = serde_json::to_value(HeldResult::from(command.request))
            .map_err(GatewayApplicationError::internal_from)?;
        let now = self.dependencies.identity_clock.now_iso();
        let id = format!(
            "work-result-{}",
            butler_turn::btcc::digest_identity(&source)
        );
        let key = id.clone();
        self.storage
            .execute(move |db| {
                outbox::enqueue(db, &key, &source, "work_result", &title, &payload, &now)?;
                db.execute(
                    "UPDATE app_initiated_messages SET bypass_quiet_hours=?1 WHERE id=?2",
                    params![bypass, key],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(app_error)?;
        let result = self.deliver_work_result(id.clone()).await;
        if let Err(error) = &result {
            self.initiated_failure(id, error).await?;
        }
        self.automation_wake.notify_one();
        result
    }

    async fn result_access(
        &self,
        command: &SendMessageCommand,
    ) -> Result<Value, GatewayApplicationError> {
        let schedule = command
            .request
            .schedule_run
            .as_ref()
            .map(|r| r.automation_id.clone());
        let chat = command.chat_id.clone();
        self.storage
            .read(move |db| {
                if let Some(id) = schedule.filter(|id| !id.is_empty()) {
                    return db
                        .query_row(
                            "SELECT access_mode FROM app_automations WHERE id=?1",
                            [id],
                            |r| r.get::<_, String>(0),
                        )
                        .map(Value::String)
                        .map_err(AppStorageError::sqlite);
                }
                let access = super::super::settings::conversation_access_mode(db, &chat)?;
                Ok(json!(super::super::settings::access_mode_name(&access)))
            })
            .await
            .map_err(app_error)
    }

    pub(super) async fn deliver_work_result(
        &self,
        id: String,
    ) -> Result<Value, GatewayApplicationError> {
        let Some(request) = self.load_work_result(id.clone()).await? else {
            return Ok(json!({"state":"posted"}));
        };
        if self.work_retry_pending(id.clone()).await? {
            return Ok(json!({"held":true}));
        }
        let mut command = SendMessageCommand {
            chat_id: "general".into(),
            request: request.into(),
        };
        command.request.schedule_run = command
            .request
            .schedule_run
            .filter(|r| r.unattended || r.connector_event);
        command.request.access_mode = Some(self.result_access(&command).await?);
        let gate = self.initiated_gate().await?;
        if !matches!(
            gate.work_hold("general", command.request.schedule_run.is_none())
                .map_err(app_error)?,
            Hold::Free
        ) {
            return Ok(json!({"held":true}));
        }
        #[cfg(feature = "e2e-fixtures")]
        self.work_send_fault(&id).await?;
        let result = self.send_message(command).await?;
        let message = result.accepted.as_ref().map(|m| m.id.clone());
        let now = self.dependencies.identity_clock.now_iso();
        self.storage.execute(move |db| {
            db.execute("UPDATE app_initiated_messages SET state='posted',reason=NULL,next_attempt_at=NULL,message_id=?1,posted_at=?2 WHERE id=?3 AND state='held'", params![message,now,id])
                .map_err(AppStorageError::sqlite)?;
            Ok(())
        }).await.map_err(app_error)?;
        serde_json::to_value(result).map_err(GatewayApplicationError::internal_from)
    }
    async fn load_work_result(
        &self,
        id: String,
    ) -> Result<Option<HeldResult>, GatewayApplicationError> {
        let key = id.clone();
        let (raw, state): (String, String) = self
            .storage
            .read(move |db| {
                db.query_row(
                    "SELECT payload_json,state FROM app_initiated_messages WHERE id=?1",
                    [key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        if state == "posted" {
            return Ok(None);
        }
        if state == "failed" {
            let key = id.clone();
            self.storage.execute(move |db| {
                db.execute("UPDATE app_initiated_messages SET state='held',reason=NULL,next_attempt_at=NULL WHERE id=?1 AND state='failed'", [key]).map_err(AppStorageError::sqlite)?;
                Ok(())
            }).await.map_err(app_error)?;
        }
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|e| GatewayApplicationError::internal_from(e).permanent())
    }
}
