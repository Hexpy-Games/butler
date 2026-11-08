use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /security/agent-import/sources (admin)
    pub async fn list_agent_import_sources(&self) -> Result<Value, Error> {
        self.admin_json(
            Method::GET,
            &["security", "agent-import", "sources"],
            &[],
            None,
        )
        .await
    }
    /// POST /security/agent-import/start (admin)
    pub async fn start_agent_import(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "agent-import", "start"],
            &[],
            Some(body),
        )
        .await
    }
}
