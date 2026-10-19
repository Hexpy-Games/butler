//! The host owns reset durability and process lifecycle; HTTP owns authentication.
use super::{ApplicationFuture, GatewayApplicationError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FullResetRequest {
    pub operation_id: String,
    pub nonce: String,
    pub confirmation: String,
}
#[derive(Serialize)]
pub struct ResetNonce {
    pub nonce: String,
    pub expires_at: String,
}
pub trait AppDataResetPort: Send + Sync + 'static {
    fn nonce(&self) -> Result<ResetNonce, GatewayApplicationError>;
    fn request(&self, input: Value) -> ApplicationFuture<Value>;
    fn resetting(&self) -> bool;
    fn generation(&self) -> &str;
}
