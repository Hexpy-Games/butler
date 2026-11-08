//! Browser import routes (Electron `app-security-admin.mjs` `SECURITY_ROUTES`): each carries the
//! app's admin credential, so a missing one is `Error::LocalMetadata`.
use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /security/browser-import/sources (admin)
    pub async fn list_browser_import_sources(&self) -> Result<Value, Error> {
        self.admin_json(
            Method::GET,
            &["security", "browser-import", "sources"],
            &[],
            None,
        )
        .await
    }
    /// POST /security/browser-import/start (admin)
    pub async fn start_browser_import(&self, body: &Value) -> Result<Value, Error> {
        self.import_post("start", body).await
    }
    /// POST /security/browser-import/folder (admin)
    pub async fn pick_browser_import_folder(&self, body: &Value) -> Result<Value, Error> {
        self.import_post("folder", body).await
    }
    /// POST /security/browser-import/disk-access (admin)
    pub async fn open_browser_import_disk_access(&self, body: &Value) -> Result<Value, Error> {
        self.import_post("disk-access", body).await
    }
    /// POST /security/browser-import/export (admin)
    pub async fn begin_browser_password_export(&self, body: &Value) -> Result<Value, Error> {
        self.import_post("export", body).await
    }
    /// POST /security/browser-import/export/poll (admin)
    pub async fn poll_browser_password_export(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "browser-import", "export", "poll"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/browser-import/export/file (admin)
    pub async fn choose_browser_password_export(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "browser-import", "export", "file"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/browser-import/export/delete (admin)
    pub async fn delete_browser_password_export(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "browser-import", "export", "delete"],
            &[],
            Some(body),
        )
        .await
    }
    /// POST /security/browser-import/export/cancel (admin)
    pub async fn cancel_browser_password_export(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "browser-import", "export", "cancel"],
            &[],
            Some(body),
        )
        .await
    }

    async fn import_post(&self, action: &str, body: &Value) -> Result<Value, Error> {
        self.admin_json(
            Method::POST,
            &["security", "browser-import", action],
            &[],
            Some(body),
        )
        .await
    }
}
