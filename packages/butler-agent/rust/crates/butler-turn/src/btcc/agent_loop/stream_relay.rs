//! Relays provider text deltas to the turn's progress as
//! `model.stream.text_delta` events, coalesced so the durable progress path
//! and the App see a bounded frame rate.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::ports::ProviderStreamObserver;
use crate::btcc::{AgentLoopProgress, RuntimeTurnEventInput};

/// Deltas arriving within this window are published as one event.
const COALESCE: Duration = Duration::from_millis(50);

/// One provider text delta of the final-answer candidate.
struct Delta {
    stream_id: String,
    sequence: u64,
    text: String,
}

/// The provider stream observer of a turn and the queue its deltas wait in
/// until the loop publishes them.
pub struct StreamRelay {
    observer: Arc<RelayObserver>,
    receiver: mpsc::UnboundedReceiver<Delta>,
}

struct RelayObserver {
    sender: mpsc::UnboundedSender<Delta>,
}

impl ProviderStreamObserver for RelayObserver {
    fn event(&self, event: &Value) {
        if event.get("type").and_then(Value::as_str) != Some("text_delta")
            || event.get("target").and_then(Value::as_str) != Some("final_candidate")
        {
            return;
        }
        let (Some(stream_id), Some(text)) = (
            event.get("streamId").and_then(Value::as_str),
            event.get("textDelta").and_then(Value::as_str),
        ) else {
            return;
        };
        // A closed queue means the loop has finished; late deltas are dropped.
        let _ = self.sender.send(Delta {
            stream_id: stream_id.to_owned(),
            sequence: event.get("sequence").and_then(Value::as_u64).unwrap_or(0),
            text: text.to_owned(),
        });
    }
}

impl Default for StreamRelay {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamRelay {
    /// A relay with an empty queue.
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            observer: Arc::new(RelayObserver { sender }),
            receiver,
        }
    }

    /// The observer to give the provider transport.
    pub fn observer(&self) -> Arc<dyn ProviderStreamObserver> {
        self.observer.clone()
    }

    /// Publishes queued deltas until `done` is cancelled, then flushes the rest.
    /// Publication failures never veto the turn.
    pub(crate) async fn publish(self, progress: &dyn AgentLoopProgress, done: CancellationToken) {
        let Self {
            observer,
            mut receiver,
        } = self;
        drop(observer);
        loop {
            let first = tokio::select! {
                delta = receiver.recv() => delta,
                () = done.cancelled() => None,
            };
            let Some(first) = first else {
                break;
            };
            let mut batch = vec![first];
            let window = tokio::time::sleep(COALESCE);
            tokio::pin!(window);
            loop {
                tokio::select! {
                    delta = receiver.recv() => match delta {
                        Some(delta) => batch.push(delta),
                        None => break,
                    },
                    () = &mut window => break,
                    () = done.cancelled() => break,
                }
            }
            emit(progress, batch).await;
        }
        let mut rest = Vec::new();
        while let Ok(delta) = receiver.try_recv() {
            rest.push(delta);
        }
        emit(progress, rest).await;
    }
}

/// Publishes a batch as one event per consecutive run of the same stream.
async fn emit(progress: &dyn AgentLoopProgress, batch: Vec<Delta>) {
    let mut runs: Vec<Delta> = Vec::new();
    for delta in batch {
        match runs.last_mut() {
            Some(last) if last.stream_id == delta.stream_id => {
                last.text.push_str(&delta.text);
                last.sequence = delta.sequence;
            }
            _ => runs.push(delta),
        }
    }
    for run in runs {
        let mut event = RuntimeTurnEventInput::new("model.stream.text_delta");
        let payload = json!({
            "streamId": run.stream_id,
            "sequence": run.sequence,
            "textDelta": run.text,
            "target": "final_candidate",
        });
        event.payload = match payload {
            Value::Object(map) => Some(map),
            _ => Some(Map::new()),
        };
        let _ = progress.emit(event).await;
    }
}
