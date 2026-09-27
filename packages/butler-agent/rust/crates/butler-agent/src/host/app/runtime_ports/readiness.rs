//! The retained foreground readiness receipt and live listener gate App dispatch.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use butler_gateway::gateway::{
    AppExecutorReadiness, GatewayApplicationError, RuntimeReadinessView,
};
use butler_runtime::operations::ServiceReadiness;

pub(crate) struct AppReadiness {
    receipt: Arc<ServiceReadiness>,
    listener_ready: Arc<AtomicBool>,
}

impl AppReadiness {
    pub(crate) fn new(receipt: Arc<ServiceReadiness>, listener_ready: Arc<AtomicBool>) -> Self {
        Self {
            receipt,
            listener_ready,
        }
    }
}

impl AppExecutorReadiness for AppReadiness {
    fn readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError> {
        let published = self
            .receipt
            .published_identity()
            .map_err(GatewayApplicationError::internal_from)?;
        let authenticated_gateway_ready = self.listener_ready.load(Ordering::Acquire);
        Ok(RuntimeReadinessView {
            authenticated_gateway_ready,
            btcc_executor_ready: published.is_some(),
            executor_pid: published.as_ref().map(|(pid, _)| *pid),
            executor_ready_at: published.map(|(_, ready_at)| ready_at),
            raw_text_included: false,
        })
    }
}
