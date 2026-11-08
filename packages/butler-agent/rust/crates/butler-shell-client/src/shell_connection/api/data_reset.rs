//! The full reset (`GET /data/reset`, `POST /data/reset`), both admin routes.
use crate::{Error, ShellClient};
use reqwest::Method;
use serde_json::Value;

impl ShellClient {
    /// GET /data/reset (admin): a fresh single-use nonce, `{nonce}`.
    pub async fn get_data_reset_nonce(&self) -> Result<Value, Error> {
        self.admin_json(Method::GET, &["data", "reset"], &[], None)
            .await
    }
    /// POST /data/reset (admin): `{operation_id, nonce, confirmation}`; the Agent answers 202 and
    /// moves its data away while it shuts down.
    pub async fn start_data_reset(&self, body: &Value) -> Result<Value, Error> {
        self.admin_json(Method::POST, &["data", "reset"], &[], Some(body))
            .await
    }
}
