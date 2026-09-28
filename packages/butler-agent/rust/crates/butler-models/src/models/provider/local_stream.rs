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

use butler_turn::btcc::{ProviderRequestError, ProviderStreamObserver};

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
            ResponseMode::HostedChatSse,
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
pub(super) struct StreamWatch<'a> {
    inner: Option<&'a dyn ProviderStreamObserver>,
    streamed: AtomicBool,
}

impl<'a> StreamWatch<'a> {
    pub(super) fn new(inner: Option<&'a dyn ProviderStreamObserver>) -> Self {
        Self {
            inner,
            streamed: AtomicBool::new(false),
        }
    }

    pub(super) fn streamed(&self) -> bool {
        self.streamed.load(Ordering::Acquire)
    }
}

impl ProviderStreamObserver for StreamWatch<'_> {
    fn event(&self, event: &Value) {
        if event.get("type").and_then(Value::as_str) == Some("text_delta") {
            self.streamed.store(true, Ordering::Release);
        }
        if let Some(inner) = self.inner {
            inner.event(event);
        }
    }

    fn round_text_discarded(&self) {
        if let Some(inner) = self.inner {
            inner.round_text_discarded();
        }
    }
}
