//! A send is accepted either with its turn or queued until the FIFO
//! dispatcher links its exact message. Turn IDs are read only here, so a
//! caller never mistakes a queued admission for a missing turn.
use std::time::Duration;

use serde_json::Value;

use super::{Gateway, HarnessError, harness_error};
use crate::e2e::scenario::turn_timeout;

impl Gateway {
    /// Sends `text` once and returns that input's turn ID.
    pub async fn say_turn(&self, chat_id: &str, text: &str) -> Result<String, HarnessError> {
        let accepted = self.say(chat_id, text).await?;
        self.accepted_turn(&accepted).await
    }

    /// The turn an accepted send belongs to. A queued admission is followed
    /// to the turn the dispatcher links to its exact client message ID.
    pub async fn accepted_turn(&self, accepted: &Value) -> Result<String, HarnessError> {
        if let Some(id) = immediate_turn_id(accepted) {
            return Ok(id);
        }
        let queued = &accepted["queued"];
        let chat = queued["chat_id"].as_str().filter(|chat| !chat.is_empty());
        let client = queued["client_message_id"]
            .as_str()
            .filter(|client| !client.is_empty());
        let (Some(chat), Some(client)) = (chat, client) else {
            return Err(harness_error(format!(
                "accepted message has no turn and no exact client identity: {accepted}"
            )));
        };
        let timeout = Duration::from_secs(turn_timeout());
        tokio::time::timeout(timeout, self.linked_turn(chat, client))
            .await
            .map_err(|_| {
                harness_error(format!(
                    "queued input in {chat} was not linked to a turn within {timeout:?}: {accepted}"
                ))
            })?
    }

    /// The native admission stores the client ID as the user-message ID.
    /// Never select a different turn by text, position, or latest state.
    async fn linked_turn(&self, chat: &str, client: &str) -> Result<String, HarnessError> {
        loop {
            if let Some(id) = self.messages(chat).await?.iter().find_map(|message| {
                (message["id"] == client && message["chat_id"] == chat && message["role"] == "user")
                    .then(|| message["turn_id"].as_str().map(str::to_owned))
                    .flatten()
            }) {
                return Ok(id);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// The turn ID an accepted send already carries. `None` means admission
/// queued the input; [`Gateway::accepted_turn`] waits for its turn.
pub fn immediate_turn_id(accepted: &Value) -> Option<String> {
    accepted["turn_id"]
        .as_str()
        .or_else(|| accepted["turn"]["turn_id"].as_str())
        .or_else(|| accepted["turn"]["id"].as_str())
        .map(str::to_owned)
}
