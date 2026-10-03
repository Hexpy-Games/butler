//! Relays the provider's answer text to the turn's progress while the loop
//! runs, as `model.stream.text_delta` events coalesced to one event per
//! stream per [`COALESCE`] window, so the durable progress path and the App
//! see a bounded frame rate. When the loop discards a round's text (the round
//! called tools, or its candidate was sent back or replaced) the relay
//! publishes `model.stream.completed` with status `discarded` for that stream,
//! after its deltas.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::ports::ProviderStreamObserver;
use crate::btcc::{AgentLoopProgress, RuntimeTurnEventInput};

/// Deltas arriving within this window are published as one event.
const COALESCE: Duration = Duration::from_millis(50);

/// One observation, in stream order.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Relayed {
    /// A provider text delta of the answer candidate.
    Delta {
        stream_id: String,
        sequence: u64,
        text: String,
    },
    /// The latest round's text is not the answer.
    Discard,
}

/// One published event.
#[derive(Debug, PartialEq, Eq)]
enum Frame {
    Text {
        stream_id: String,
        sequence: u64,
        text: String,
    },
    Discarded {
        stream_id: String,
    },
}

/// The provider stream observer of a turn and the queue its observations wait
/// in until the loop publishes them.
pub struct StreamRelay {
    observer: Arc<RelayObserver>,
    receiver: mpsc::UnboundedReceiver<Relayed>,
}

struct RelayObserver {
    sender: mpsc::UnboundedSender<Relayed>,
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
        let _ = self.sender.send(Relayed::Delta {
            stream_id: stream_id.to_owned(),
            sequence: event.get("sequence").and_then(Value::as_u64).unwrap_or(0),
            text: text.to_owned(),
        });
    }

    fn round_text_discarded(&self) {
        let _ = self.sender.send(Relayed::Discard);
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

    /// The observer to give the provider transport and the loop.
    pub fn observer(&self) -> Arc<dyn ProviderStreamObserver> {
        self.observer.clone()
    }

    /// Publishes queued observations until `done` is cancelled, then flushes
    /// the rest. Publication failures never veto the turn.
    pub(crate) async fn publish(self, progress: &dyn AgentLoopProgress, done: CancellationToken) {
        let Self {
            observer,
            mut receiver,
        } = self;
        drop(observer);
        // The stream whose text the App shows, until a discard closes it.
        let mut open = None;
        loop {
            let first = tokio::select! {
                item = receiver.recv() => item,
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
                    item = receiver.recv() => match item {
                        Some(item) => batch.push(item),
                        None => break,
                    },
                    () = &mut window => break,
                    () = done.cancelled() => break,
                }
            }
            emit(progress, frames(&mut open, batch)).await;
        }
        let mut rest = Vec::new();
        while let Ok(item) = receiver.try_recv() {
            rest.push(item);
        }
        emit(progress, frames(&mut open, rest)).await;
    }
}

/// The frames of one batch: consecutive deltas of one stream merge into one
/// text frame (with the last sequence); a discard closes the open stream.
fn frames(open: &mut Option<String>, batch: Vec<Relayed>) -> Vec<Frame> {
    let mut frames: Vec<Frame> = Vec::new();
    for item in batch {
        match item {
            Relayed::Delta {
                stream_id,
                sequence,
                text,
            } => {
                *open = Some(stream_id.clone());
                if !uncoalesced()
                    && let Some(Frame::Text {
                        stream_id: last,
                        sequence: last_sequence,
                        text: last_text,
                    }) = frames.last_mut()
                    && *last == stream_id
                {
                    last_text.push_str(&text);
                    *last_sequence = sequence;
                    continue;
                }
                frames.push(Frame::Text {
                    stream_id,
                    sequence,
                    text,
                });
            }
            Relayed::Discard => {
                if let Some(stream_id) = open.take() {
                    frames.push(Frame::Discarded { stream_id });
                }
            }
        }
    }
    frames
}

async fn emit(progress: &dyn AgentLoopProgress, frames: Vec<Frame>) {
    for frame in frames {
        let mut payload = Map::new();
        let kind = match frame {
            Frame::Text {
                stream_id,
                sequence,
                text,
            } => {
                payload.insert("streamId".into(), stream_id.into());
                payload.insert("sequence".into(), sequence.into());
                payload.insert("textDelta".into(), text.into());
                payload.insert("target".into(), "final_candidate".into());
                "model.stream.text_delta"
            }
            Frame::Discarded { stream_id } => {
                payload.insert("streamId".into(), stream_id.into());
                payload.insert("status".into(), "discarded".into());
                "model.stream.completed"
            }
        };
        let mut event = RuntimeTurnEventInput::new(kind);
        event.payload = Some(payload);
        // Streamed text is display only: the final answer is delivered anyway.
        if let Err(error) = progress.emit(event).await {
            butler_core::diagnostic!(
                "[native-btcc] stream relay publish failed code={}",
                error.code()
            );
        }
    }
}

fn uncoalesced() -> bool {
    matches!(
        std::env::var("BUTLER_E2E_TIER").as_deref(),
        Ok("stub" | "perf")
    ) && std::env::var_os("BUTLER_E2E_STREAM_UNCOALESCED").is_some()
}
