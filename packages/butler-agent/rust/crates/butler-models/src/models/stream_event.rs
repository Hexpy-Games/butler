//! Internal provider projections. Raw argument fragments are never public events.
use butler_core::tool_protocol::ToolCallStreamEvent;

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

    pub(super) fn call(
        &mut self,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
        index: u64,
        name: &str,
        arguments: Option<&str>,
    ) {
        let Some(observer) = observer else { return };
        self.sequence += 1;
        let event = match arguments {
            None => ToolCallStreamEvent::ToolCallStart {
                stream_id: self.id.clone(),
                sequence: self.sequence,
                call_index: index,
                tool_name: name.into(),
            },
            Some(delta) => ToolCallStreamEvent::ToolCallDelta {
                stream_id: self.id.clone(),
                sequence: self.sequence,
                call_index: index,
                arguments_delta: delta.into(),
            },
        };
        observer.tool_call(&event);
    }

    pub(super) fn text(
        &mut self,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
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
