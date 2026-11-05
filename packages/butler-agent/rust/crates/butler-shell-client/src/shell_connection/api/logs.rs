use crate::{Download, Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /logs?source&level&category&q&trace_id&turn_id&chat_id&message_id&since&until&cursor&limit
    #[expect(
        clippy::too_many_arguments,
        reason = "desktop route query parameters remain explicit scalars"
    )]
    pub async fn list_logs(
        &self,
        source: Option<&str>,
        level: Option<&str>,
        category: Option<&str>,
        q: Option<&str>,
        trace_id: Option<&str>,
        turn_id: Option<&str>,
        chat_id: Option<&str>,
        message_id: Option<&str>,
        since: Option<&str>,
        until: Option<&str>,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = source {
            query.push(("source", value.to_string()));
        }
        if let Some(value) = level {
            query.push(("level", value.to_string()));
        }
        if let Some(value) = category {
            query.push(("category", value.to_string()));
        }
        if let Some(value) = q {
            query.push(("q", value.to_string()));
        }
        if let Some(value) = trace_id {
            query.push(("trace_id", value.to_string()));
        }
        if let Some(value) = turn_id {
            query.push(("turn_id", value.to_string()));
        }
        if let Some(value) = chat_id {
            query.push(("chat_id", value.to_string()));
        }
        if let Some(value) = message_id {
            query.push(("message_id", value.to_string()));
        }
        if let Some(value) = since {
            query.push(("since", value.to_string()));
        }
        if let Some(value) = until {
            query.push(("until", value.to_string()));
        }
        if let Some(value) = cursor {
            query.push(("cursor", value.to_string()));
        }
        if let Some(value) = limit {
            query.push(("limit", value.to_string()));
        }
        self.json(Method::GET, &["logs"], &query, None).await
    }
    /// DELETE /logs
    pub async fn delete_logs(&self) -> Result<Value, Error> {
        self.json(Method::DELETE, &["logs"], &[], None).await
    }
    /// GET /logs/config
    pub async fn get_logs_config(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["logs", "config"], &[], None).await
    }
    /// PUT /logs/config
    pub async fn update_logs_config(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::PUT, &["logs", "config"], &[], Some(body))
            .await
    }
    /// GET /logs/storage
    pub async fn get_logs_storage(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["logs", "storage"], &[], None)
            .await
    }
    /// GET /logs/trace/{id}
    pub async fn get_log_trace(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["logs", "trace", id], &[], None)
            .await
    }
    /// GET /logs/trace?turn_id&chat_id&message_id
    pub async fn get_logs_trace(
        &self,
        turn_id: Option<&str>,
        chat_id: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = turn_id {
            query.push(("turn_id", value.to_string()));
        }
        if let Some(value) = chat_id {
            query.push(("chat_id", value.to_string()));
        }
        if let Some(value) = message_id {
            query.push(("message_id", value.to_string()));
        }
        self.json(Method::GET, &["logs", "trace"], &query, None)
            .await
    }
    /// GET /logs/bodies/{reference}
    pub async fn read_log_body(&self, reference: &str) -> Result<Download, Error> {
        self.download(Method::GET, &["logs", "bodies", reference], &[])
            .await
    }
    /// POST /logs/export
    pub async fn export_logs(&self, body: &Value) -> Result<Download, Error> {
        let response = self
            .request(
                Method::POST,
                self.url(&["logs", "export"], &[])?,
                &super::super::transport::Body::Json(body),
                false,
            )
            .await?;
        Self::read_download(response).await
    }
}
