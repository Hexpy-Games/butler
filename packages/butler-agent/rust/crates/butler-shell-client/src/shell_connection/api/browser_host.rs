use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// Publishes the native browser host's tab snapshot (local admin only).
    pub async fn browser_host_events(&self, body: &Value) -> Result<Value, Error> {
        self.admin_raw_json(
            Method::POST,
            &["internal", "browser-host", "events"],
            Some(body),
        )
        .await
    }

    /// Prepares or publishes a conversation download (local admin only).
    pub async fn browser_host_downloads(&self, body: &Value) -> Result<Value, Error> {
        self.admin_raw_json(
            Method::POST,
            &["internal", "browser-host", "downloads"],
            Some(body),
        )
        .await
    }
}
