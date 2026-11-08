use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /security (admin)
    pub async fn get_security(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["security"], &[], None).await
    }
    /// PATCH /settings (admin). The body carries `security`; other settings go through
    /// `update_settings`.
    pub async fn update_security_settings(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::PATCH, &["settings"], &[], Some(body))
            .await
    }
    /// POST /security/pairing (admin)
    pub async fn issue_pairing_code(&self) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["security", "pairing"], &[], None)
            .await
    }
    /// GET /security/pairing (admin)
    pub async fn get_pairing_status(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["security", "pairing"], &[], None)
            .await
    }
    /// GET /security/devices (admin)
    pub async fn list_paired_devices(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["security", "devices"], &[], None)
            .await
    }
    /// DELETE /security/devices/{id} (admin)
    pub async fn revoke_paired_device(&self, device_id: &str) -> Result<Value, Error> {
        self.admin_json(
            Method::DELETE,
            &["security", "devices", device_id],
            &[],
            None,
        )
        .await
    }
    /// DELETE /security/devices (admin)
    pub async fn revoke_all_paired_devices(&self) -> Result<Value, Error> {
        self.admin_json(Method::DELETE, &["security", "devices"], &[], None)
            .await
    }
}
