//! Streaming for local OpenAI-compatible servers (Ollama, LM Studio,
//! llama.cpp, other self-hosted servers).
//!
//! A local round asks for `stream: true` so the App shows the answer while it
//! arrives. A server that refuses a streamed request (an HTTP error, or an
//! event stream it cannot finish) gets the same round again without
//! streaming. When that works, the endpoint is remembered for the life of
//! the process and is not asked to stream again. Nothing falls back once
//! answer text has been shown: the round then fails as any other round.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde_json::Value;

use butler_turn::btcc::{ModelRoundError, ProviderRequestError, ProviderStreamObserver};

use super::super::transport::ResponseMode;
use super::contracts::ProviderRequestConfig;
use super::serialize::Carrier;

/// HTTP statuses with which servers refuse a streamed request they would
/// answer without streaming.
const REFUSED_STREAM_STATUSES: [u16; 7] = [400, 405, 406, 415, 422, 500, 501];

/// The local endpoints that answered only without streaming.
#[derive(Default)]
pub(super) struct LocalStreaming {
    refused: Mutex<HashSet<String>>,
}

impl LocalStreaming {
    /// The carrier of a round: `base` (the provider's own carrier), except a
    /// local round streams unless `allow` is false or its endpoint refused.
    pub(super) fn carrier(
        &self,
        config: &ProviderRequestConfig,
        base: (Carrier, ResponseMode, &'static str),
        allow: bool,
    ) -> (Carrier, ResponseMode, &'static str) {
        if !allow
            || config.metadata.provider_id != "local"
            || self.refused.lock().contains(config.endpoint.as_str())
        {
            return base;
        }
        (
            Carrier::Chat { stream: true },
            ResponseMode::HostedChatSse(config.metadata.chat_wire_policy),
            base.2,
        )
    }

    /// Remembers that `endpoint` answers only without streaming.
    pub(super) fn refuse(&self, endpoint: &url::Url) {
        self.refused.lock().insert(endpoint.as_str().to_owned());
    }
}

/// Whether a failed streamed local round may be retried without streaming.
pub(super) fn falls_back(
    carrier: Carrier,
    error: &ProviderRequestError,
    watch: &StreamWatch<'_>,
) -> bool {
    matches!(carrier, Carrier::Chat { stream: true })
        && !watch.streamed()
        && (matches!(
            error.code.as_str(),
            "provider_stream_malformed_event" | "provider_stream_interrupted"
        ) || (error.code == "provider_api_error"
            && error
                .status_code
                .is_some_and(|status| REFUSED_STREAM_STATUSES.contains(&status))))
}

/// Forwards stream events and records whether answer text was shown.
/// Every provider round goes through one (not only local ones).
pub(super) struct StreamWatch<'a> {
    inner: Option<&'a dyn ProviderStreamObserver>,
    streamed: AtomicBool,
    tools_observed: AtomicBool,
    summary: bool,
    round_id: Option<&'a str>,
}

impl<'a> StreamWatch<'a> {
    pub(super) fn new(inner: Option<&'a dyn ProviderStreamObserver>) -> Self {
        Self {
            inner,
            streamed: AtomicBool::new(false),
            tools_observed: AtomicBool::new(false),
            summary: false,
            round_id: None,
        }
    }

    pub(super) fn with_summary(mut self, summary: bool, round_id: Option<&'a str>) -> Self {
        self.summary = summary;
        self.round_id = round_id;
        self
    }

    /// JSON-only carriers still declare identity before their one complete argument fragment.
    pub(super) fn complete_tools(&self, result: &butler_turn::btcc::ModelRoundResult) {
        use butler_core::tool_protocol::ToolCallStreamEvent;
        if self.tools_observed.load(Ordering::Acquire) {
            return;
        }
        let stream_id = format!("tool-stream-{}", uuid::Uuid::new_v4().simple());
        let mut sequence = 0;
        for (index, call) in result.tool_calls.iter().enumerate() {
            sequence += 1;
            self.tool_call(&ToolCallStreamEvent::ToolCallStart {
                stream_id: stream_id.clone(),
                call_index: index as u64,
                sequence,
                tool_name: call.name.clone(),
                call_id: Some(call.id.clone()),
            });
            if let Ok(arguments_delta) = serde_json::to_string(&call.arguments) {
                sequence += 1;
                self.tool_call(&ToolCallStreamEvent::ToolCallDelta {
                    stream_id: stream_id.clone(),
                    call_index: index as u64,
                    sequence,
                    arguments_delta,
                });
            }
        }
    }

    /// Whether this round showed answer text (even text later discarded).
    pub(super) fn streamed(&self) -> bool {
        self.streamed.load(Ordering::Acquire)
    }

    /// The round failed with `error`: text it showed is not the answer.
    /// Whoever repeats the round (the model route, or the non-streaming
    /// fallback) then shows its own text instead of adding to it, and a
    /// turn stopped meanwhile keeps none of it. A stop itself (the round was
    /// cancelled) keeps the text: a stopped turn keeps its partial answer.
    pub(super) fn discard_after(&self, error: &ModelRoundError) {
        let stopped = match error {
            ModelRoundError::Cancelled => true,
            ModelRoundError::Provider(error) => error.code == "provider_cancelled",
            _ => false,
        };
        if (self.streamed() || self.tools_observed.load(Ordering::Acquire)) && !stopped {
            self.round_text_discarded();
        }
    }
}

impl ProviderStreamObserver for StreamWatch<'_> {
    fn event(&self, event: &Value) {
        if matches!(
            event["type"].as_str(),
            Some("tool_call_start" | "tool_call_delta")
        ) && let Ok(tool) = serde_json::from_value(event.clone())
        {
            self.tool_call(&tool);
            return;
        }
        if event.get("type").and_then(Value::as_str) == Some("text_delta") {
            self.streamed.store(true, Ordering::Release);
        }
        if let Some(inner) = self.inner {
            if event["type"] == "reasoning_delta" {
                let mut event = event.clone();
                if !self.summary {
                    event["display"] = "internal".into();
                }
                event["roundId"] = self.round_id.into();
                inner.event(&event);
            } else {
                inner.event(event);
            }
        }
    }

    fn tool_call(&self, event: &butler_core::tool_protocol::ToolCallStreamEvent) {
        // Tool arguments are not answer text: a refused local stream still
        // falls back without streaming, as it did before arguments streamed.
        self.tools_observed.store(true, Ordering::Release);
        if let Some(inner) = self.inner {
            inner.tool_call(event);
        }
    }

    fn round_text_continued(&self, text: &str) {
        if let Some(inner) = self.inner {
            inner.round_text_continued(text);
        }
    }

    fn round_text_rejected(&self) {
        if let Some(inner) = self.inner {
            inner.round_text_rejected();
        }
    }

    fn round_text_discarded(&self) {
        if let Some(inner) = self.inner {
            inner.round_text_discarded();
        }
    }
}
