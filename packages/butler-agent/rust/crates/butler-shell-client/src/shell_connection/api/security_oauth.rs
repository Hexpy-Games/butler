use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /security/oauth (admin)
    pub async fn list_oauth_credentials(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["security", "oauth"], &[], None)
            .await
    }
    /// DELETE /security/oauth/{id} (admin)
    pub async fn remove_oauth_credential(&self, id: &str) -> Result<Value, Error> {
        self.admin_json(Method::DELETE, &["security", "oauth", id], &[], None)
            .await
    }
}
