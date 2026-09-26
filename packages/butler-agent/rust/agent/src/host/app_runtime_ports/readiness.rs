//! The retained foreground readiness receipt and live listener gate App dispatch.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::{
    gateway::{AppExecutorReadiness, GatewayApplicationError, RuntimeReadinessView},
    operations::ServiceReadiness,
};

pub(crate) struct NativeAppReadiness {
    receipt: Arc<ServiceReadiness>,
    listener_ready: Arc<AtomicBool>,
}

impl NativeAppReadiness {
    pub(crate) fn new(receipt: Arc<ServiceReadiness>, listener_ready: Arc<AtomicBool>) -> Self {
        Self {
            receipt,
            listener_ready,
        }
    }
}

impl AppExecutorReadiness for NativeAppReadiness {
    fn readiness(&self) -> Result<RuntimeReadinessView, GatewayApplicationError> {
        let published = self
            .receipt
            .published_identity()
            .map_err(|_| GatewayApplicationError::Internal)?;
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
