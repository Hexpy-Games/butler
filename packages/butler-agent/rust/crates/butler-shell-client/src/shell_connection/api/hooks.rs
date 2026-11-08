use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /hooks (admin)
    pub async fn get_hooks(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["hooks"], &[], None).await
    }
    /// PUT /hooks (admin)
    pub async fn save_hooks(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::PUT, &["hooks"], &[], Some(body))
            .await
    }
    /// GET /hooks/runs (admin)
    pub async fn get_hook_runs(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["hooks", "runs"], &[], None)
            .await
    }
    /// POST /hooks/{id}/test (admin)
    pub async fn test_hook(&self, id: &str) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["hooks", id, "test"],
            &[],
            Some(&Value::Object(serde_json::Map::new())),
        )
        .await
    }
}
