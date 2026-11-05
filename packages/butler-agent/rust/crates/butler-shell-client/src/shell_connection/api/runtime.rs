use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /health
    pub async fn health(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["health"], &[], None).await
    }
    /// GET /runtime-readiness
    pub async fn get_runtime_readiness(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["runtime-readiness"], &[], None)
            .await
    }
    /// GET /updates
    pub async fn get_updates(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["updates"], &[], None).await
    }
    /// POST /updates/check
    pub async fn check_updates(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["updates", "check"], &[], Some(body))
            .await
    }
    /// POST /updates/apply
    pub async fn apply_update(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["updates", "apply"], &[], Some(body))
            .await
    }
    /// POST /updates/cancel
    pub async fn cancel_update(&self) -> Result<Value, Error> {
        self.json(Method::POST, &["updates", "cancel"], &[], None)
            .await
    }
    /// POST /updates/progress
    pub async fn set_update_progress(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["updates", "progress"], &[], Some(body))
            .await
    }
}
