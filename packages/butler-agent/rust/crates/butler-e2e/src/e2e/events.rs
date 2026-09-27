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
                    }
                }
            }
        });
        Ok(Self { events, task })
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Waits until an event satisfies `predicate`; returns it.
    pub async fn wait_for(
        &self,
        timeout: Duration,
        predicate: impl Fn(&Value) -> bool,
    ) -> Result<Value, HarnessError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(found) = self.snapshot().into_iter().find(|event| predicate(event)) {
                return Ok(found);
            }
            if Instant::now() > deadline || self.task.is_finished() {
                return Err(harness_error(format!(
                    "live event not seen within {timeout:?} ({} events collected)",
                    self.snapshot().len()
                )));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
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
