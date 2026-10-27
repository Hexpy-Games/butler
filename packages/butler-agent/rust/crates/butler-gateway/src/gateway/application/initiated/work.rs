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
    access_mode: Option<Value>,
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
            access_mode: r.access_mode,
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
            access_mode: r.access_mode,
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
        if command.chat_id != "general" {
            return serde_json::to_value(self.send_message(command).await?)
                .map_err(GatewayApplicationError::internal_from);
        }
        let gate = self.initiated_gate().await?;
        let held = self
            .storage
            .read(move |db| Ok(!matches!(gate.hold(db, "general", false)?, Hold::Free)))
            .await
            .map_err(app_error)?;
        if !held {
            return serde_json::to_value(self.send_message(command).await?)
                .map_err(GatewayApplicationError::internal_from);
        }
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
        self.storage
            .execute(move |db| {
                outbox::enqueue(db, &id, &source, "work_result", &title, &payload, &now)
            })
            .await
            .map_err(app_error)?;
        self.automation_wake.notify_one();
        Ok(json!({"held":true}))
    }

    pub(super) async fn deliver_work_result(
        &self,
        id: String,
    ) -> Result<(), GatewayApplicationError> {
        let key = id.clone();
        let raw: String = self
            .storage
            .read(move |db| {
                db.query_row(
                    "SELECT payload_json FROM app_initiated_messages WHERE id=?1",
                    [key],
                    |r| r.get(0),
                )
                .map_err(AppStorageError::sqlite)
            })
            .await
            .map_err(app_error)?;
        let request: HeldResult =
            serde_json::from_str(&raw).map_err(GatewayApplicationError::internal_from)?;
        let result = self
            .send_message(SendMessageCommand {
                chat_id: "general".into(),
                request: request.into(),
            })
            .await?;
        let message = result.accepted.map(|m| m.id);
        let now = self.dependencies.identity_clock.now_iso();
        self.storage.execute(move |db| {
            db.execute("UPDATE app_initiated_messages SET state='posted',message_id=?1,posted_at=?2,quiet=0 WHERE id=?3 AND state='held'", params![message,now,id])
                .map_err(AppStorageError::sqlite)?;
            Ok(())
        }).await.map_err(app_error)
    }
}
