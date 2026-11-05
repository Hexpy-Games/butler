use crate::{Error, ShellClient, Upload};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /mcp-servers
    pub async fn list_mcp_servers(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["mcp-servers"], &[], None).await
    }
    /// POST /mcp-servers
    pub async fn create_mcp_server(&self, body: &Value) -> Result<Value, Error> {
        self.json(Method::POST, &["mcp-servers"], &[], Some(body))
            .await
    }
    /// PATCH /mcp-servers/{id}
    pub async fn update_mcp_server(&self, id: &str, body: &Value) -> Result<Value, Error> {
        self.json(Method::PATCH, &["mcp-servers", id], &[], Some(body))
            .await
    }
    /// DELETE /mcp-servers/{id}
    pub async fn delete_mcp_server(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::DELETE, &["mcp-servers", id], &[], None)
            .await
    }
    /// POST /mcp-servers/{id}/probe
    pub async fn probe_mcp_server(&self, id: &str) -> Result<Value, Error> {
        self.json(Method::POST, &["mcp-servers", id, "probe"], &[], None)
            .await
    }
    /// GET /mcp-capabilities
    pub async fn list_mcp_capabilities(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["mcp-capabilities"], &[], None)
            .await
    }
    /// GET /skills
    pub async fn list_skills(&self) -> Result<Value, Error> {
        self.json(Method::GET, &["skills"], &[], None).await
    }
    /// POST /skills/import (multipart: file, project_id).
    pub async fn import_skill(
        &self,
        project_id: Option<&str>,
        file: &Upload,
    ) -> Result<Value, Error> {
        let fields = project_id.map(|id| ("project_id", id));
        self.upload(&["skills", "import"], &[], fields.as_slice(), file)
            .await
    }
}
