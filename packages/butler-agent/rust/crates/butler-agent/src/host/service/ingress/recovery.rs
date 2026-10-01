//! Publish crash/deadline outcomes before the App can replace their durable claims.

use super::{IngressDispatcher, IngressError, dispatch, recover_stale};
use std::collections::HashSet;
use tokio_util::sync::CancellationToken;

impl IngressDispatcher {
    pub(crate) async fn recover_interrupted(
        &self,
        stop: &CancellationToken,
    ) -> Result<(), IngressError> {
        recover_stale(self.queue.clone(), HashSet::new()).await?;
        while !stop.is_cancelled() {
            let queue = self.queue.clone();
            let items = tokio::task::spawn_blocking(move || {
                queue.claim_eligible(5, dispatch::needs_interruption_report)
            })
            .await
            .map_err(|e| IngressError::new("inbound_queue_worker_failed", e.to_string()))??;
            if items.is_empty() {
                break;
            }
            for item in items {
                dispatch::recover_interrupted(
                    item,
                    &self.queue,
                    &self.bindings,
                    self.delivery.as_ref(),
                )
                .await?;
            }
        }
        Ok(())
    }
}
