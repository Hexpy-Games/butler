use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /model-catalog
    pub async fn get_model_catalog(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["model-catalog"], &[], None).await
    }
    /// POST /model-catalog/provider-credentials
    pub async fn upsert_provider_credential(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["model-catalog", "provider-credentials"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /model-catalog/registered-models
    pub async fn register_hosted_model(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["model-catalog", "registered-models"],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /model-catalog/registered-models/{model_ref}
    pub async fn delete_hosted_model(&self, model_ref: &str) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["model-catalog", "registered-models", model_ref],
            &[],
            None,
        )
        .await
    }
    /// POST /model-catalog/local/discover
    pub async fn discover_local_models(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["model-catalog", "local", "discover"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /model-catalog/local-models
    pub async fn register_local_model(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["model-catalog", "local-models"],
            &[],
            Some(body),
        )
        .await
    }
    /// PATCH /model-catalog/local-models/{model_ref}
    pub async fn update_local_model(&self, model_ref: &str, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::PATCH,
            &["model-catalog", "local-models", model_ref],
            &[],
            Some(body),
        )
        .await
    }
    /// DELETE /model-catalog/local-models/{model_ref}
    pub async fn delete_local_model(&self, model_ref: &str) -> Result<Value, Error> {
        self.json(
            Method::DELETE,
            &["model-catalog", "local-models", model_ref],
            &[],
            None,
        )
        .await
    }
}
