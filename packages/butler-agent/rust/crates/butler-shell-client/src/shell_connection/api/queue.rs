use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /session-queue?session_id
    pub async fn list_session_queue(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["session-queue"],
            &[("session_id", session_id.to_string())],
            None,
        )
        .await
    }
    /// POST /session-queue
    pub async fn queue_message(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["session-queue"], &[], Some(body))
            .await
    }
    /// PATCH /session-queue/{queued_message_id}
    pub async fn update_queued_message(
        &self,
        queued_message_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::PATCH,
            &["session-queue", queued_message_id],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /session-queue/{queued_message_id}
    pub async fn delete_queued_message(&self, queued_message_id: &str) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["session-queue", queued_message_id],
            &[],
            None,
        )
        .await
    }
    /// POST /session-queue/{queued_message_id}/send-now
    pub async fn send_queued_message_now(&self, queued_message_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["session-queue", queued_message_id, "send-now"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
}
