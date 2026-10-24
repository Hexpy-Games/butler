//! Exercise the claim-release race with an acknowledged dispatcher drain.
use super::super::*;
use super::support::*;
use std::sync::Arc;
use tokio::sync::Notify;

pub(super) struct ObservedNative {
    pub(super) native: Arc<Native>,
    pub(super) enqueued: Arc<Notify>,
}
impl AppNativeIngress for ObservedNative {
    fn enqueue(&self, turn: AppTurn) -> ApplicationFuture<EnqueueReceipt> {
        let result = self.native.enqueue(turn);
        self.enqueued.notify_one();
        result
    }
    fn find(&self, turn: AppTurn) -> ApplicationFuture<Option<EnqueueReceipt>> {
        self.native.find(turn)
    }
    fn enqueue_cancel(&self, cancel: AppCancellation) -> ApplicationFuture<EnqueueReceipt> {
        self.native.enqueue_cancel(cancel)
    }
    fn stop_confirmed(&self, turn: String) -> ApplicationFuture<bool> {
        self.native.stop_confirmed(turn)
    }
}

pub(super) struct ReadinessGate(pub(super) tokio::sync::watch::Receiver<bool>);
impl AppExecutorReadiness for ReadinessGate {
    fn wait_ready(&self) -> ApplicationFuture<()> {
        let mut ready = self.0.clone();
        Box::pin(async move {
            ready
                .wait_for(|ready| *ready)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            Ok(())
        })
    }
    fn readiness(&self) -> Result<crate::gateway::RuntimeReadinessView, GatewayApplicationError> {
        let mut view = Ready.readiness()?;
        view.btcc_executor_ready = *self.0.borrow();
        Ok(view)
    }
}
