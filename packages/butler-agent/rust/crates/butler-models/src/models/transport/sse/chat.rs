//! OpenAI-compatible chat completion streams (`/chat/completions` with
//! `stream: true`), read into the non-streamed response shape.

use reqwest::Response;
use serde_json::{Map, Value};

use butler_turn::btcc::ProviderRequestError;

use super::super::super::{diagnostics, request_guard::RequestProgress};
use super::consume;

const HOSTED_FRAME_LIMIT: usize = 8 * 1024 * 1024;

/// Reads an OpenAI-compatible chat completion stream into the non-streamed
/// response shape. Answer text is also relayed to `observer` as
/// `text_delta` events while it arrives, so the App shows it streaming.
pub(in crate::models::transport) async fn hosted_chat(
    response: Response,
    provider: &str,
    api: &str,
    progress: RequestProgress,
    observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
) -> Result<Value, Box<ProviderRequestError>> {
    let mut state = ChatState::new();
    consume(response, provider, api, Some(HOSTED_FRAME_LIMIT), |frame| {
        progress.record_progress();
        state.frame(frame, observer, provider, api)
    })
    .await?;
    if !state.done {
        return Err(Box::new(diagnostics::protocol(
            provider,
            api,
            "provider_stream_interrupted",
        )));
    }
    Ok(state.response())
}

/// Accumulated chat completion chunks of one streamed response.
struct ChatState {
    stream_id: String,
    sequence: u64,
    text: String,
    id: String,
    model: Option<Value>,
    usage: Option<Value>,
    role: String,
    finish_reason: Value,
    tool_calls: Vec<Value>,
    done: bool,
}

impl ChatState {
    fn new() -> Self {
        Self {
            // One id per response: providers may reuse chunk ids across
            // requests, and the App keys streamed text by stream id.
            stream_id: format!("chat-stream-{}", uuid::Uuid::new_v4().simple()),
            sequence: 0,
            text: String::new(),
            id: String::new(),
            model: None,
            usage: None,
            role: "assistant".to_owned(),
            finish_reason: Value::Null,
            tool_calls: Vec::new(),
            done: false,
        }
    }

    fn frame(
        &mut self,
        frame: &str,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
        provider: &str,
        api: &str,
    ) -> Result<Option<Value>, Box<ProviderRequestError>> {
        if frame == "[DONE]" {
            self.done = true;
            return Ok(None);
        }
        let malformed = || {
            Box::new(diagnostics::protocol(
                provider,
                api,
                "provider_stream_malformed_event",
            ))
        };
        let event = serde_json::from_str::<Value>(frame).map_err(|_| malformed())?;
        if !event.is_object() {
            return Err(malformed());
        }
        if let Some(error) = event
            .get("error")
            .or_else(|| event.pointer("/response/error"))
            .filter(|value| value.is_object())
        {
            let status = error
                .get("status")
                .or_else(|| error.get("code"))
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(400);
            return Err(Box::new(diagnostics::http(
                provider,
                api,
                status,
                Some(&event),
                None,
            )));
        }
        self.absorb(&event, observer);
        Ok(None)
    }

    fn absorb(
        &mut self,
        event: &Value,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
    ) {
        if let Some(value) = event.get("id").and_then(Value::as_str) {
            value.clone_into(&mut self.id);
        }
        if let Some(value) = event.get("model") {
            self.model = Some(value.clone());
        }
        if let Some(value) = event.get("usage") {
            self.usage = Some(value.clone());
        }
        if let Some(delta) = event.pointer("/choices/0/delta") {
            if let Some(value) = delta.get("role").and_then(Value::as_str) {
                value.clone_into(&mut self.role);
            }
            if let Some(value) = delta.get("content").and_then(Value::as_str) {
                self.text.push_str(value);
                self.emit_text(value, observer);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                merge_tool_calls(&mut self.tool_calls, calls);
            }
        }
        if let Some(value) = event.pointer("/choices/0/finish_reason") {
            self.finish_reason = value.clone();
        }
    }

    fn emit_text(
        &mut self,
        delta: &str,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
    ) {
        let Some(observer) = observer.filter(|_| !delta.is_empty()) else {
            return;
        };
        self.sequence += 1;
        observer.event(&serde_json::json!({
            "type": "text_delta",
            "streamId": self.stream_id,
            "sequence": self.sequence,
            "textDelta": delta,
            "target": "final_candidate",
        }));
    }

    fn response(self) -> Value {
        let mut assistant = Map::new();
        assistant.insert("role".into(), Value::String(self.role));
        assistant.insert(
            "content".into(),
            if self.text.is_empty() {
                Value::Null
            } else {
                Value::String(self.text)
            },
        );
        if !self.tool_calls.is_empty() {
            assistant.insert("tool_calls".into(), Value::Array(self.tool_calls));
        }
        let mut output = Map::new();
        output.insert(
            "choices".into(),
            Value::Array(vec![serde_json::json!({
                "index": 0,
                "finish_reason": self.finish_reason,
                "message": assistant,
            })]),
        );
        output.insert("id".into(), Value::String(self.id));
        output.insert(
            "model".into(),
            self.model.unwrap_or(Value::String(String::new())),
        );
        if let Some(usage) = self.usage {
            output.insert("usage".into(), usage);
        }
        Value::Object(output)
    }
}

fn merge_tool_calls(output: &mut Vec<Value>, deltas: &[Value]) {
    for delta in deltas {
        let index = usize::try_from(delta.get("index").and_then(Value::as_u64).unwrap_or(0))
            .unwrap_or(usize::MAX);
        while output.len() <= index {
            output.push(serde_json::json!({"id":"","type":"function","function":{"name":"","arguments":""}}));
        }
        let target = &mut output[index];
        append(target, "/id", delta.get("id"));
        append(target, "/function/name", delta.pointer("/function/name"));
        append(
            target,
            "/function/arguments",
            delta.pointer("/function/arguments"),
        );
    }
}

fn append(target: &mut Value, pointer: &str, source: Option<&Value>) {
    let Some(fragment) = source.and_then(Value::as_str) else {
        return;
    };
    if let Some(Value::String(value)) = target.pointer_mut(pointer) {
        value.push_str(fragment);
    }
}
