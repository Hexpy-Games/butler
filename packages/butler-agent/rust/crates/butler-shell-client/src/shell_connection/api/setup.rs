use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /setup/readiness
    pub async fn get_setup_readiness(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["setup", "readiness"], &[], None)
            .await
    }
    /// POST /setup/readiness/retry
    pub async fn retry_setup_readiness(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["setup", "readiness", "retry"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /setup/memory-model
    pub async fn choose_memory_model(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["setup", "memory-model"], &[], Some(body))
            .await
    }
    /// GET /setup/chatgpt-account
    pub async fn get_chat_gpt_account(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["setup", "chatgpt-account"], &[], None)
            .await
    }
    /// POST /setup/chatgpt-account/notice
    pub async fn acknowledge_chat_gpt_notice(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["setup", "chatgpt-account", "notice"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /setup/chatgpt-account/sign-out
    pub async fn sign_out_chat_gpt(&self) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["setup", "chatgpt-account", "sign-out"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// POST /setup/oauth/start
    pub async fn start_setup_oauth(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["setup", "oauth", "start"], &[], Some(body))
            .await
    }
    /// GET /setup/oauth/{flow_id}
    pub async fn get_setup_oauth_flow(&self, flow_id: &str) -> Result<Value, Error> {
        self.json(Method::GET, &["setup", "oauth", flow_id], &[], None)
            .await
    }
    /// POST /setup/oauth/{flow_id}/cancel
    pub async fn cancel_setup_oauth(&self, flow_id: &str) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["setup", "oauth", flow_id, "cancel"],
            &[],
            Some(&serde_json::json!({})),
        )
        .await
    }
    /// GET /setup/local-model-servers
    pub async fn get_local_model_servers(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["setup", "local-model-servers"], &[], None)
            .await
    }
    /// POST /setup/credentials/verify
    pub async fn verify_setup_credential(&self, body: &Value) -> Result<Value, Error> {
        self.json(
            Method::POST,
            &["setup", "credentials", "verify"],
            &[],
            Some(body),
        )
        .await
    }
}
