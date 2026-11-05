use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /turns?chat_id&cursor
    pub async fn list_turns(&self, chat_id: &str, cursor: u64) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["turns"],
            &[
                ("chat_id", chat_id.to_string()),
                ("cursor", cursor.to_string()),
            ],
            None,
        )
        .await
    }
    /// POST /turns/{turn_id}/retry
    pub async fn retry_turn(&self, turn_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["turns", turn_id, "retry"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /turns/{turn_id}/retry-current
    pub async fn retry_turn_with_current_controls(&self, turn_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["turns", turn_id, "retry-current"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// GET /turns/{turn_id}/operations/{request_id}/output?result_id&offset
    pub async fn get_operation_output(
        &self,
        turn_id: &str,
        request_id: &str,
        result_id: &str,
        offset: u64,
    ) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["turns", turn_id, "operations", request_id, "output"],
            &[
                ("result_id", result_id.to_string()),
                ("offset", offset.to_string()),
            ],
            None,
        )
        .await
    }
    /// POST /steward-relations/{relation_id}/cancel
    pub async fn cancel_steward(&self, relation_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["steward-relations", relation_id, "cancel"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /steward-relations/{relation_id}/resume
    pub async fn resume_steward(&self, relation_id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["steward-relations", relation_id, "resume"],
            &[],
            Some(body),
        )
        .await
    }
}
