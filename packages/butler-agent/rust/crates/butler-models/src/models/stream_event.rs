//! Internal provider projections. Raw argument fragments are never public events.
use butler_core::tool_protocol::ToolCallStreamEvent;
use butler_turn::btcc::ProviderStreamObserver;

/// The id Butler gives a Gemini function call (Gemini names none): its
/// round, its part position and its tool name.
pub(super) fn gemini_call_id(round: u32, index: usize, name: &str) -> String {
    format!("gemini_call_{round}_{index}_{name}")
}

pub(super) struct StreamProjection {
    id: String,
    sequence: u64,
}

impl StreamProjection {
    pub(super) fn new() -> Self {
        Self {
            id: format!("provider-stream-{}", uuid::Uuid::new_v4().simple()),
            sequence: 0,
        }
    }

    /// Declares a call's identity (and the id its executed call carries)
    /// before any of its argument fragments.
    pub(super) fn start(
        &mut self,
        observer: Option<&dyn ProviderStreamObserver>,
        index: u64,
        name: &str,
        call_id: Option<&str>,
    ) {
        let Some(observer) = observer else { return };
        self.sequence += 1;
        observer.tool_call(&ToolCallStreamEvent::ToolCallStart {
            stream_id: self.id.clone(),
            call_index: index,
            sequence: self.sequence,
            tool_name: name.into(),
            call_id: call_id.filter(|id| !id.is_empty()).map(str::to_owned),
        });
    }

    /// One exact argument fragment of a started call.
    pub(super) fn delta(
        &mut self,
        observer: Option<&dyn ProviderStreamObserver>,
        index: u64,
        fragment: &str,
    ) {
        let Some(observer) = observer else { return };
        self.sequence += 1;
        observer.tool_call(&ToolCallStreamEvent::ToolCallDelta {
            stream_id: self.id.clone(),
            call_index: index,
            sequence: self.sequence,
            arguments_delta: fragment.into(),
        });
    }

    pub(super) fn text(
        &mut self,
        observer: Option<&dyn ProviderStreamObserver>,
        text: &str,
        reasoning: bool,
    ) {
        let Some(observer) = observer.filter(|_| !text.is_empty()) else {
            return;
        };
        self.sequence += 1;
        observer.event(&serde_json::json!({
            "type": if reasoning { "reasoning_delta" } else { "text_delta" },
            "streamId": self.id, "sequence": self.sequence, "textDelta": text,
            "target": "final_candidate", "charCount": text.encode_utf16().count(),
        }));
    }
}
