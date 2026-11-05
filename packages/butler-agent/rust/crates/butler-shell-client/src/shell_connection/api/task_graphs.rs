use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /sessions/{id}/task-graphs?revision&cursor&limit
    pub async fn get_session_task_graphs(
        &self,
        id: &str,
        revision: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = revision {
            query.push(("revision", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        self.json(Method::GET, &["sessions", id, "task-graphs"], &query, None)
            .await
    }
    /// GET /plans/{id}/task-graph?revision&cursor&limit
    pub async fn get_plan_task_graph(
        &self,
        id: &str,
        revision: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = revision {
            query.push(("revision", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        self.json(Method::GET, &["plans", id, "task-graph"], &query, None)
            .await
    }
    /// GET /tasks/{id}/document?revision&cursor&limit
    pub async fn get_task_document(
        &self,
        id: &str,
        revision: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = revision {
            query.push(("revision", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        self.json(Method::GET, &["tasks", id, "document"], &query, None)
            .await
    }
}
