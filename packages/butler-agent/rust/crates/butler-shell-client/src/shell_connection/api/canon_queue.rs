use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /sessions/{session_id}/canon/queue
    pub async fn get_canon_queue(&self, session_id: &str) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["sessions", session_id, "canon", "queue"],
            &[],
            None,
        )
        .await
    }
    /// POST /sessions/{session_id}/canon/queue/edits
    pub async fn edit_canon_queue(&self, session_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "canon", "queue", "edits"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /sessions/{session_id}/canon/queue/holds/{epic_id}
    pub async fn decide_canon_hold(
        &self,
        session_id: &str,
        epic_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "canon", "queue", "holds", epic_id],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /sessions/{session_id}/canon/queue/take/{epic_id}
    pub async fn take_canon_here(
        &self,
        session_id: &str,
        epic_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["sessions", session_id, "canon", "queue", "take", epic_id],
            &[],
            Some(body),
        )
        .await
    }
}
