use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /memory/inventory
    pub async fn get_memory_inventory(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "inventory"], &[], None)
            .await
    }
    /// POST /memory/inventory/check
    pub async fn check_memory_inventory(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["memory", "inventory", "check"],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /memory/instructions
    pub async fn list_memory_instructions(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "instructions"], &[], None)
            .await
    }
    /// DELETE /memory/instructions/{id}
    pub async fn delete_memory_instruction(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["memory", "instructions", id],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /memory/projects/{id}
    pub async fn get_memory_project(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "projects", id], &[], None)
            .await
    }
    /// POST /memory/cleanup
    pub async fn create_memory_cleanup(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["memory", "cleanup"], &[], Some(body))
            .await
    }
    /// GET /memory/cleanup/{id}
    pub async fn get_memory_cleanup(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "cleanup", id], &[], None)
            .await
    }
    /// DELETE /memory/cleanup/{id}
    pub async fn delete_memory_cleanup(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["memory", "cleanup", id], &[], None)
            .await
    }
    /// POST /memory/reset/chat-memory
    pub async fn reset_chat_memory(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["memory", "reset", "chat-memory"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /memory/reset/profile
    pub async fn reset_memory_profile(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["memory", "reset", "profile"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /memory/reset/projects/{id}
    pub async fn reset_memory_project(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["memory", "reset", "projects", id],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /memory/reset/{op}
    pub async fn get_memory_reset(&self, op: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "reset", op], &[], None)
            .await
    }
    /// GET /memory/patterns
    pub async fn list_memory_patterns(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "patterns"], &[], None)
            .await
    }
    /// DELETE /memory/patterns/{id}
    pub async fn delete_memory_pattern(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::DELETE, &["memory", "patterns", id], &[], Some(body))
            .await
    }
    /// GET /memory/pattern-proposals
    pub async fn list_memory_pattern_proposals(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "pattern-proposals"], &[], None)
            .await
    }
    /// POST /memory/pattern-proposals/{id}
    pub async fn resolve_memory_pattern_proposal(
        &self,
        id: &str,
        body: &Value,
    ) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["memory", "pattern-proposals", id],
            &[],
            Some(body),
        )
        .await
    }
    /// GET /memory/consolidation
    pub async fn get_memory_consolidation(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["memory", "consolidation"], &[], None)
            .await
    }
    /// POST /memory/consolidation
    pub async fn create_memory_consolidation(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["memory", "consolidation"], &[], Some(body))
            .await
    }
}
