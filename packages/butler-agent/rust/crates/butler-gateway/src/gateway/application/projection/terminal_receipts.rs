//! Retry only failed terminal notifications; an empty set arms no idle work.
use super::{GatewayApplicationError, ProjectionContext};
use std::{collections::BTreeMap, time::Duration};
use tokio::time::Instant;

#[derive(Default)]
pub(super) struct Pending(parking_lot::Mutex<BTreeMap<String, Instant>>);

impl ProjectionContext {
    /// A failed notification stays pending for its retry (and startup
    /// reconciliation); it never fails the projection or the read that ran it.
    pub(super) async fn finish_terminal_turn(&self, turn: String) {
        self.terminal_receipts
            .0
            .lock()
            .insert(turn.clone(), Instant::now() + Duration::from_secs(1));
        match self.notify_terminal_turn(turn.clone()).await {
            Ok(()) => {
                self.terminal_receipts.0.lock().remove(&turn);
            }
            Err(error) => tracing::warn!(%error, "Terminal notification remains pending"),
        }
    }

    async fn notify_terminal_turn(&self, turn: String) -> Result<(), GatewayApplicationError> {
        super::super::canon_queue::turn_ended(
            &self.storage,
            &self.dependencies.canon,
            turn.clone(),
        )
        .await?;
        self.retention_wake.turn(turn).await?;
        self.wake_queued_automations();
        Ok(())
    }

    pub(super) async fn retry_terminal_receipts(&self) {
        let due = self
            .terminal_receipts
            .0
            .lock()
            .iter()
            .filter(|(_, deadline)| **deadline <= Instant::now())
            .map(|(turn, _)| turn.clone())
            .collect::<Vec<_>>();
        for turn in due {
            self.finish_terminal_turn(turn).await;
        }
    }

    pub(super) fn terminal_receipt_delay(&self) -> Option<Duration> {
        self.terminal_receipts
            .0
            .lock()
            .values()
            .min()
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }
}
