use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /credentials
    pub async fn list_credentials(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["credentials"], &[], None).await
    }
    /// POST /credentials
    pub async fn save_credential(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["credentials"], &[], Some(body))
            .await
    }
    /// PATCH /credentials/{name}
    pub async fn replace_credential(&self, name: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["credentials", name], &[], Some(body))
            .await
    }
    /// DELETE /credentials/{name}?force
    pub async fn delete_credential(&self, name: &str, force: Option<bool>) -> Result<Value, Error> {
        let mut query = Vec::new();
        if let Some(value) = force {
            query.push(("force", value.to_string()));
        }
        self.json(Method::DELETE, &["credentials", name], &query, None)
            .await
    }
}
