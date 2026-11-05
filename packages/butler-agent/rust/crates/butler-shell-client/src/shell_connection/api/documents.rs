use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// POST /documents
    pub async fn create_document(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["documents"], &[], Some(body))
            .await
    }
    /// GET /documents/{id}
    pub async fn get_document(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["documents", id], &[], None).await
    }
    /// PUT /documents/{id}
    pub async fn save_document(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PUT, &["documents", id], &[], Some(body))
            .await
    }
    /// GET /documents/{id}/revisions
    pub async fn list_document_revisions(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["documents", id, "revisions"], &[], None)
            .await
    }
    /// GET /documents/{id}/revisions/{rev}
    pub async fn get_document_revision(&self, id: &str, rev: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["documents", id, "revisions", rev], &[], None)
            .await
    }
    /// GET /documents/{id}/diff?from
    pub async fn get_document_diff(&self, id: &str, from: u64) -> Result<Value, Error> {
        self.json(
            Method::GET,
            &["documents", id, "diff"],
            &[("from", from.to_string())],
            None,
        )
        .await
    }
    /// POST /documents/{id}/restore
    pub async fn restore_document(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["documents", id, "restore"], &[], Some(body))
            .await
    }
    /// POST /documents/{id}/seen
    pub async fn mark_document_seen(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["documents", id, "seen"], &[], Some(body))
            .await
    }
    /// POST /documents/{id}/blocks/{index}
    pub async fn save_document_block(&self, id: &str, index: &str) -> Result<Value, Error> {
        self.json(Method::POST, &["documents", id, "blocks", index], &[], None)
            .await
    }
}
