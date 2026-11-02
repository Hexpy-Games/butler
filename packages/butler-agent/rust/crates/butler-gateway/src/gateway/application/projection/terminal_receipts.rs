//! Retry only failed terminal notifications; an empty set arms no idle work.
use super::{GatewayApplicationError, ProjectionContext};
use std::{collections::BTreeMap, time::Duration};
use tokio::time::Instant;

#[derive(Default)]
pub(super) struct Pending(parking_lot::Mutex<BTreeMap<String, Instant>>);

impl ProjectionContext {
    pub(super) async fn finish_terminal_turn(
        &self,
        turn: String,
    ) -> Result<(), GatewayApplicationError> {
        self.terminal_receipts
            .0
            .lock()
            .insert(turn.clone(), Instant::now() + Duration::from_secs(1));
        self.notify_terminal_turn(turn.clone()).await?;
        self.terminal_receipts.0.lock().remove(&turn);
        Ok(())
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
            if let Err(error) = self.finish_terminal_turn(turn).await {
                tracing::warn!(%error, "Terminal notification remains pending");
            }
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
