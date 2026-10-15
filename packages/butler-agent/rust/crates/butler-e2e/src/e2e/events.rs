//! `/events/live` subscriber: collects the UI-bound event stream in the
//! background, as the App does.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::Value;

use super::gateway::Gateway;
use super::{HarnessError, harness_error};

pub struct LiveEvents {
    events: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    changed: tokio::sync::watch::Receiver<()>,
}

impl LiveEvents {
    /// Subscribes from `cursor` (0: from the start of the retained log).
    pub async fn subscribe(gateway: &Gateway, cursor: u64) -> Result<Self, HarnessError> {
        let response = reqwest::Client::new()
            .get(format!("{}/events/live?cursor={cursor}", gateway.base))
            .bearer_auth(&gateway.token)
            .send()
            .await?;
        if response.status().as_u16() != 200 {
            return Err(harness_error(format!(
                "/events/live answered {}",
                response.status()
            )));
        }
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let (changed, changes) = tokio::sync::watch::channel(());
        let task = tokio::spawn(async move {
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            while let Some(Ok(bytes)) = stream.next().await {
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(end) = buffer.find("\n\n") {
                    let block: String = buffer.drain(..end + 2).collect();
                    let data: String = block
                        .lines()
                        .filter_map(|line| line.strip_prefix("data:"))
                        .map(str::trim_start)
                        .collect::<Vec<_>>()
                        .join("\n");
                    if let Ok(value) = serde_json::from_str::<Value>(&data) {
                        sink.lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(value);
                        changed.send_replace(());
                    }
                }
            }
        });
        Ok(Self {
            events,
            task,
            changed: changes,
        })
    }

    /// Whether the gateway ended the stream.
    pub fn is_closed(&self) -> bool {
        self.task.is_finished()
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Call after subscribing before submission. Wait for the committed state
    /// event before fetching the complete turn, avoiding projection-refresh polls.
    pub async fn wait_turn(
        &self,
        gateway: &Gateway,
        chat: &str,
        turn: &str,
        states: &[&str],
        timeout: Duration,
    ) -> Result<Value, HarnessError> {
        self.wait_for(timeout, |event| {
            event["type"] == "turn.state_changed"
                && event_turn_id(event) == Some(turn)
                && event["payload"]["state"]
                    .as_str()
                    .or_else(|| event["payload"]["turn"]["state"].as_str())
                    .is_some_and(|state| states.contains(&state))
        })
        .await?;
        let value = gateway
            .turn(chat, turn)
            .await?
            .ok_or_else(|| harness_error("event's complete turn is missing"))?;
        if !states.contains(&super::gateway::turn_state(&value)) {
            return Err(harness_error(format!(
                "turn moved beyond expected states: {value}"
            )));
        }
        Ok(value)
    }

    /// Scans each received event once and sleeps until the stream changes.
    pub async fn wait_for(
        &self,
        timeout: Duration,
        predicate: impl Fn(&Value) -> bool,
    ) -> Result<Value, HarnessError> {
        let deadline = Instant::now() + timeout;
        let mut after = 0;
        let mut changed = self.changed.clone();
        loop {
            // Observe the version before scanning, so an arrival during the scan
            // remains visible to changed() even if no waiter was registered yet.
            changed.borrow_and_update();
            {
                let events = self
                    .events
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(event) = events.iter().skip(after).find(|event| predicate(event)) {
                    return Ok(event.clone());
                }
                after = events.len();
            }
            if Instant::now() > deadline || self.task.is_finished() {
                return Err(harness_error(format!(
                    "live event not seen within {timeout:?} ({} events collected)",
                    self.snapshot().len()
                )));
            }
            if tokio::time::timeout(
                deadline.saturating_duration_since(Instant::now()),
                changed.changed(),
            )
            .await
            .is_err()
            {
                return Err(harness_error("live event wait expired"));
            }
        }
    }
}

impl Drop for LiveEvents {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Kind of an `agent.turn_event` (`payload.event.kind`), if any.
pub fn turn_event_kind(event: &Value) -> Option<&str> {
    event["payload"]["event"]["kind"].as_str()
}

pub fn event_turn_id(event: &Value) -> Option<&str> {
    event["payload"]["turn_id"]
        .as_str()
        .or_else(|| event["payload"]["turn"]["id"].as_str())
        .or_else(|| event["payload"]["message"]["turn_id"].as_str())
}
