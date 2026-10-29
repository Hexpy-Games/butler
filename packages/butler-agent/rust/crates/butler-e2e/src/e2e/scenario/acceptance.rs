//! Admission can be queued while the FIFO dispatcher links its exact message.
use super::{HarnessError, Scenario, Value, harness_error, turn_timeout};
use std::time::Duration;

impl Scenario {
    /// Sends once and observes that same input through queue admission and
    /// terminal delivery, within the original turn deadline.
    pub async fn turn(&self, chat: &str, text: &str) -> Result<(String, Value), HarnessError> {
        self.turn_within(chat, text, Duration::from_secs(turn_timeout()))
            .await
    }

    /// Sends and observes the same input within a caller-selected deadline.
    pub async fn turn_within(
        &self,
        chat: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<(String, Value), HarnessError> {
        tokio::time::timeout(timeout, async {
            let turn_id = self.gw.say_turn(chat, text).await?;
            let turn = self.gw.wait_terminal(chat, &turn_id, timeout).await?;
            Ok((turn_id, turn))
        })
        .await
        .map_err(|_| {
            harness_error(format!(
                "turn in {chat} did not complete within {timeout:?}"
            ))
        })?
    }
}
