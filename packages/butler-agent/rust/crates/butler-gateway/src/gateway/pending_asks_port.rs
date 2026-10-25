//! Pending-ask HTTP boundary shared by browser and desktop clients.
use super::*;

pub trait GatewayPendingAsks: Send + Sync {
    fn pending_asks(
        &self,
        _session: Option<String>,
        _limit: usize,
        _before: Option<String>,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn dismiss_pending_ask(
        &self,
        _session: String,
        _ask_id: String,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
}
