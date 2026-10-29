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
        let chat = command.chat_id;
        let retry_chat = chat.clone();
        self.storage
            .execute(move |db| {
                outbox::enqueue(db, (&key, &chat), &source, "work_result", &title, &payload, &now)?;
                db.execute(
                    "UPDATE app_initiated_messages SET bypass_quiet_hours=?1 WHERE id=?2 AND state='held' AND bypass_quiet_hours<>?1",
                    params![bypass, key],
                )
                .map_err(AppStorageError::sqlite)?;
                Ok(())
            })
            .await
            .map_err(app_error)?;
        self.retry_model_results(retry_chat).await?;
        let result = self.deliver_work_result(id.clone()).await;
        if let Err(error) = &result {
            self.initiated_failure(id, error).await?;
            if matches!(error, GatewayApplicationError::Public { code, .. } if code == "session_model_unavailable")
            {
                return Ok(json!({"held":true}));
            }
            if error.failure_class() == crate::gateway::error::FailureClass::Permanent {
                self.deliver_initiated().await?;
                return Ok(json!({"state":"failed"}));
            }
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
        let (chat, state, raw) = self.load_work_result(id.clone()).await?;
        if state != "held" {
            return Ok(json!({"state":state}));
        }
        let request: HeldResult = serde_json::from_str(&raw)
            .map_err(|e| GatewayApplicationError::internal_from(e).permanent())?;
        if self.work_retry_pending(id.clone()).await? {
            return Ok(json!({"held":true}));
        }
        let mut command = SendMessageCommand {
            chat_id: chat.clone(),
            request: request.into(),
        };
        command.request.schedule_run = command
            .request
            .schedule_run
            .filter(|r| r.unattended || r.connector_event);
        command.request.access_mode = Some(self.result_access(&command).await?);
        command.request.model = None;
        command.request.reasoning_effort = None;
        let gate = self.initiated_gate().await?;
        if !matches!(
            gate.work_hold(&chat, command.request.schedule_run.is_none())
                .map_err(app_error)?,
            Hold::Free
        ) {
            return Ok(json!({"held":true}));
        }
        let Some(_posting) = super::posting::Reservation::claim(self, id.clone())
            .await
            .map_err(app_error)?
        else {
            return Ok(json!({"held":true}));
        };
        let result = self.send_work_result(&id, command).await?;
        let message = result.accepted.as_ref().map(|m| m.id.clone());
        let now = self.dependencies.identity_clock.now_iso();
        self.storage.execute(move |db| {
            db.execute("UPDATE app_initiated_messages SET state='posted',posting=0,reason=NULL,next_attempt_at=NULL,message_id=?1,posted_at=?2 WHERE id=?3 AND state='held'", params![message,now,id])
                .map_err(AppStorageError::sqlite)?;
            super::failures::withdraw(db, &id)?;
            Ok(())
        }).await.map_err(app_error)?;
        serde_json::to_value(result).map_err(GatewayApplicationError::internal_from)
    }
    async fn send_work_result(
        &self,
        id: &str,
        command: SendMessageCommand,
    ) -> Result<crate::gateway::MessageSendResult, GatewayApplicationError> {
        self.work_send_fault(id).await?;
        self.send_message(command).await
    }

    async fn load_work_result(
        &self,
        id: String,
    ) -> Result<(String, String, String), GatewayApplicationError> {
        self.storage
            .read(move |db| {
                db.query_row(
                    "SELECT chat_id,state,payload_json FROM app_initiated_messages WHERE id=?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)
    }
}
