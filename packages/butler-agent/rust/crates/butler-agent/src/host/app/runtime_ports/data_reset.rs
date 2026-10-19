//! Runtime reset port keeps the gateway independent of native lifecycle owners.
use crate::host::service::data_reset::Control;
use butler_gateway::gateway::{
    AppDataResetPort, ApplicationFuture, GatewayApplicationError, ResetNonce,
};
use std::sync::Arc;
pub(crate) struct AppDataReset(pub Arc<Control>);
impl AppDataResetPort for AppDataReset {
    fn nonce(&self) -> Result<ResetNonce, GatewayApplicationError> {
        self.0.nonce()
    }
    fn request(&self, input: serde_json::Value) -> ApplicationFuture<serde_json::Value> {
        self.0.request(&input)
    }
    fn resetting(&self) -> bool {
        self.0.resetting()
    }
    fn generation(&self) -> &str {
        self.0.generation()
    }
}
