//! Admission can be queued while the FIFO dispatcher links its exact message.
use super::{HarnessError, Scenario, Value, accepted_turn_id, harness_error, turn_timeout};
use std::time::Duration;

impl Scenario {
    /// Sends once and observes that same input through queue admission and
    /// terminal delivery, within the original turn deadline.
    pub async fn turn(&self, chat: &str, text: &str) -> Result<(String, Value), HarnessError> {
        let timeout = Duration::from_secs(turn_timeout());
        tokio::time::timeout(timeout, async {
            let accepted = self.gw.say(chat, text).await?;
            let turn_id = resolve(self, chat, &accepted).await?;
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

async fn resolve(s: &Scenario, chat: &str, accepted: &Value) -> Result<String, HarnessError> {
    if let Ok(id) = accepted_turn_id(accepted) {
        return Ok(id);
    }
    let queued = &accepted["queued"];
    let client = queued["client_message_id"]
        .as_str()
        .filter(|client| !client.is_empty() && queued["chat_id"] == chat)
        .ok_or_else(|| {
            harness_error(format!(
                "admission has no exact client identity: {accepted}"
            ))
        })?;
    loop {
        // The native admission stores this client ID as the user-message ID.
        // Never select a different turn by text, position, or latest state.
        if let Some(id) = s.gw.messages(chat).await?.iter().find_map(|message| {
            (message["id"] == client && message["chat_id"] == chat && message["role"] == "user")
                .then(|| message["turn_id"].as_str().map(str::to_owned))
                .flatten()
        }) {
            return Ok(id);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
