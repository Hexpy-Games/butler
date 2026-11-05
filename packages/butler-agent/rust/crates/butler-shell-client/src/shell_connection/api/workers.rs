use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /worker-activity?include_history&limit&offset&cursor
    pub async fn list_worker_activity(
        &self,
        include_history: bool,
        limit: Option<u32>,
        offset: Option<u64>,
        cursor: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        query.push(("include_history", include_history.to_string()));
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = offset {
            query.push(("offset", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        self.json(Method::GET, &["worker-activity"], &query, None)
            .await
    }
    /// GET /worker-activity/{worker_id}
    pub async fn get_worker_activity(&self, worker_id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["worker-activity", worker_id], &[], None)
            .await
    }
    /// GET /sessions/{session_id}/worker-activity?limit&offset&cursor
    pub async fn list_session_worker_activity(
        &self,
        session_id: &str,
        limit: Option<u32>,
        offset: Option<u64>,
        cursor: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = offset {
            query.push(("offset", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        self.json(
            Method::GET,
            &["sessions", session_id, "worker-activity"],
            &query,
            None,
        )
        .await
    }
    /// GET /sessions/{session_id}/worker-activity/history?limit&offset&cursor
    pub async fn list_session_worker_activity_history(
        &self,
        session_id: &str,
        limit: Option<u32>,
        offset: Option<u64>,
        cursor: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        if let Some(value) = offset {
            query.push(("offset", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        self.json(
            Method::GET,
            &["sessions", session_id, "worker-activity", "history"],
            &query,
            None,
        )
        .await
    }
    /// POST /worker-activity/{worker_id}/control
    pub async fn control_worker_activity(
        &self,
        worker_id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["worker-activity", worker_id, "control"],
            &[],
            Some(body),
        )
        .await
    }
}
