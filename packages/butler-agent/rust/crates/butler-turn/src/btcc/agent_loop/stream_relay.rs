//! Relays the provider's answer text to the turn's progress while the loop
//! runs, as `model.stream.text_delta` events coalesced to one event per
//! stream per [`COALESCE`] window, so the durable progress path and the App
//! see a bounded frame rate. When the loop discards a round's text (the round
//! called tools, or its candidate was sent back or replaced) the relay
//! publishes `model.stream.completed` with status `discarded` for that stream,
//! after its deltas.

mod partial;

use butler_core::tool_protocol::ToolCallStreamEvent;
use parking_lot::Mutex;
use std::collections::HashSet;
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
    Thinking {
        round_id: String,
        stream_id: String,
        text: String,
    },
    ClearThinking,
    Tool(ToolCallStreamEvent),
    /// The latest round's text is not the answer.
    Discard {
        rejected: bool,
    },
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
        rejected: bool,
    },
}

/// The provider stream observer of a turn and the queue its observations wait
/// in until the loop publishes them.
pub struct StreamRelay {
    observer: Arc<RelayObserver>,
    receiver: mpsc::UnboundedReceiver<Relayed>,
    answer_blocks: Option<Arc<dyn AnswerBlocksStreamPort>>,
}

struct RelayObserver {
    sender: mpsc::UnboundedSender<Relayed>,
    calls: Mutex<HashSet<(String, u64)>>,
    partial: Mutex<partial::Partial>,
}

impl ProviderStreamObserver for RelayObserver {
    fn event(&self, event: &Value) {
        if matches!(
            event["type"].as_str(),
            Some("tool_call_start" | "tool_call_delta")
        ) && let Ok(tool) = serde_json::from_value::<ToolCallStreamEvent>(event.clone())
        {
            self.tool_call(&tool);
            return;
        }
        if event["type"] == "reasoning_delta" && event["display"] == "summary" {
            if let (Some(round), Some(stream), Some(text)) = (
                event["roundId"].as_str(),
                event["streamId"].as_str(),
                event["textDelta"].as_str(),
            ) {
                let _ = self.sender.send(Relayed::Thinking {
                    round_id: round.into(),
                    stream_id: stream.into(),
                    text: text.into(),
                });
            }
            return;
        }
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
        // Empty provider deltas carry no text and cannot satisfy the durable
        // stream event contract. Never let one block later session progress.
        if text.is_empty() {
            return;
        }
        self.partial.lock().delta(stream_id, text);
        // A closed queue means the loop has finished; late deltas are dropped.
        let _ = self.sender.send(Relayed::Delta {
            stream_id: stream_id.to_owned(),
            sequence: event.get("sequence").and_then(Value::as_u64).unwrap_or(0),
            text: text.to_owned(),
        });
    }

    fn tool_call(&self, event: &ToolCallStreamEvent) {
        if matches!(event, ToolCallStreamEvent::ToolCallStart { .. }) {
            let _ = self.sender.send(Relayed::ClearThinking);
        }
        let mut calls = self.calls.lock();
        let accepted = match event {
            ToolCallStreamEvent::ToolCallStart {
                stream_id,
                call_index,
                tool_name,
                ..
            } => {
                let key = (stream_id.clone(), *call_index);
                calls.remove(&key);
                tool_name == "answer_blocks" && calls.insert(key)
            }
            ToolCallStreamEvent::ToolCallDelta {
                stream_id,
                call_index,
                ..
            } => calls.contains(&(stream_id.clone(), *call_index)),
        };
        if accepted {
            let _ = self.sender.send(Relayed::Tool(event.clone()));
        }
    }

    fn round_text_continued(&self, text: &str) {
        self.partial.lock().retain(text);
    }

    fn round_text_discarded(&self) {
        self.partial.lock().discard();
        self.calls.lock().clear();
        let _ = self.sender.send(Relayed::Discard { rejected: false });
    }

    fn round_text_rejected(&self) {
        self.partial.lock().reject();
        self.calls.lock().clear();
        let _ = self.sender.send(Relayed::Discard { rejected: true });
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
            observer: Arc::new(RelayObserver {
                sender,
                calls: Mutex::default(),
                partial: Mutex::default(),
            }),
            receiver,
            answer_blocks: None,
        }
    }

    /// Binds the agent's private argument consumer; no durable progress events are used.
    pub fn with_answer_blocks(mut self, port: Arc<dyn AnswerBlocksStreamPort>) -> Self {
        self.answer_blocks = Some(port);
        self
    }

    /// The observer to give the provider transport and the loop.
    pub fn observer(&self) -> Arc<dyn ProviderStreamObserver> {
        self.observer.clone()
    }

    /// Publishes queued observations until `done` is cancelled, then flushes
    /// the rest. Publication failures never veto the turn.
    pub async fn publish(self, progress: &dyn AgentLoopProgress, done: CancellationToken) {
        let Self {
            observer,
            mut receiver,
            answer_blocks,
        } = self;
        let partial = observer;
        // The stream whose text the App shows, until a discard closes it.
        let mut open = None;
        let mut thinking = super::thinking_line::ThinkingLine::default();
        loop {
            let first = tokio::select! {
                () = async {
                    match thinking.deadline() {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => { thinking.flush(progress).await; continue; }
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
            let batch =
                forward_tools(batch, answer_blocks.as_deref(), progress, &mut thinking).await;
            emit(progress, frames(&mut open, batch)).await;
        }
        let mut rest = Vec::new();
        while let Ok(item) = receiver.try_recv() {
            rest.push(item);
        }
        let rest = forward_tools(rest, answer_blocks.as_deref(), progress, &mut thinking).await;
        emit(progress, frames(&mut open, rest)).await;
        let joined = partial.partial.lock().joined();
        if let Some(text) = joined {
            emit(
                progress,
                vec![Frame::Text {
                    stream_id: "joined-answer".into(),
                    sequence: 1,
                    text,
                }],
            )
            .await;
        }
        thinking.clear(progress).await;
    }
}

/// The frames of one batch: consecutive deltas of one stream merge into one
/// text frame (with the last sequence); a discard closes the open stream.
fn frames(open: &mut Option<String>, batch: Vec<Relayed>) -> Vec<Frame> {
    let mut frames: Vec<Frame> = Vec::new();
    for item in batch {
        match item {
            Relayed::Tool(_) | Relayed::Thinking { .. } | Relayed::ClearThinking => {}
            Relayed::Delta {
                stream_id,
                sequence,
                text,
            } => {
                *open = Some(stream_id.clone());
                if let Some(Frame::Text {
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
            Relayed::Discard { rejected } => {
                if let Some(stream_id) = open.take() {
                    frames.push(Frame::Discarded {
                        stream_id,
                        rejected,
                    });
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
            Frame::Discarded {
                stream_id,
                rejected,
            } => {
                payload.insert("streamId".into(), stream_id.into());
                payload.insert("status".into(), "discarded".into());
                if rejected {
                    payload.insert("reason".into(), "answer_rejected".into());
                }
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

/// Agent-owned incremental argument processing, outside the durable event path.
pub trait AnswerBlocksStreamPort: Send + Sync {
    /// Receives an answer_blocks start or exact argument fragment in provider order.
    fn tool_call<'a>(
        &'a self,
        event: ToolCallStreamEvent,
        progress: &'a dyn AgentLoopProgress,
    ) -> crate::btcc::PortFuture<'a, ()>;
    /// Drops per-round private parser state.
    fn clear(&self);
}

async fn forward_tools(
    batch: Vec<Relayed>,
    port: Option<&dyn AnswerBlocksStreamPort>,
    progress: &dyn AgentLoopProgress,
    thinking: &mut super::thinking_line::ThinkingLine,
) -> Vec<Relayed> {
    let mut text = Vec::new();
    for item in batch {
        match item {
            Relayed::Thinking {
                round_id,
                stream_id,
                text,
            } => {
                thinking.push(round_id, stream_id, &text, progress).await;
            }
            Relayed::ClearThinking => thinking.clear(progress).await,
            Relayed::Tool(event) => {
                if let Some(port) = port
                    && let Err(error) = port.tool_call(event, progress).await
                {
                    butler_core::diagnostic!(
                        "[native-btcc] draft relay failed code={}",
                        error.code()
                    );
                }
            }
            item => {
                thinking.clear(progress).await;
                if matches!(item, Relayed::Discard { .. })
                    && let Some(port) = port
                {
                    port.clear();
                }
                text.push(item);
            }
        }
    }
    text
}
