//! OpenAI-compatible chat completion streams (`/chat/completions` with
//! `stream: true`), read into the non-streamed response shape.

use reqwest::Response;
use serde_json::{Map, Value};

use butler_turn::btcc::ProviderRequestError;

use super::super::super::{diagnostics, request_guard::RequestProgress};
use super::consume;
use crate::models::stream_event::StreamProjection;

const HOSTED_FRAME_LIMIT: usize = 8 * 1024 * 1024;
/// Most tool calls one streamed answer may carry.
const MAX_TOOL_CALLS: usize = 128;

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
    // Some servers end the stream after the finish reason without `[DONE]`:
    // the answer is complete (their non-streamed answers always were).
    if !state.done && state.finish_reason.is_null() {
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
    projection: StreamProjection,
    emitted_arguments: Vec<Option<usize>>,
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
            projection: StreamProjection::new(),
            emitted_arguments: Vec::new(),
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
        if !self.absorb(&event, observer) {
            return Err(malformed());
        }
        Ok(None)
    }

    /// Takes one chunk in; false for a chunk no server sends (a tool call
    /// index past [`MAX_TOOL_CALLS`]).
    fn absorb(
        &mut self,
        event: &Value,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
    ) -> bool {
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
                for call in calls {
                    let delta = std::slice::from_ref(call);
                    if !merge_tool_calls(&mut self.tool_calls, delta) {
                        return false;
                    }
                    self.emit_calls(delta, observer);
                }
            }
        }
        if let Some(value) = event.pointer("/choices/0/finish_reason") {
            self.finish_reason = value.clone();
        }
        true
    }

    fn emit_text(
        &mut self,
        delta: &str,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
    ) {
        self.projection.text(observer, delta, false);
    }

    fn emit_calls(
        &mut self,
        deltas: &[Value],
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
    ) {
        self.emitted_arguments.resize(self.tool_calls.len(), None);
        for delta in deltas {
            let Ok(index) = usize::try_from(delta["index"].as_u64().unwrap_or(0)) else {
                continue;
            };
            let call = &self.tool_calls[index];
            let id = call["id"].as_str().unwrap_or("");
            let name = call["function"]["name"].as_str().unwrap_or("");
            if id.is_empty() || name.is_empty() || delta.pointer("/function/arguments").is_none() {
                continue;
            }
            let arguments = call["function"]["arguments"].as_str().unwrap_or("");
            let emitted = &mut self.emitted_arguments[index];
            if emitted.is_none() {
                self.projection.call(observer, index as u64, name, None);
            }
            let offset = emitted.unwrap_or(0);
            if arguments.len() > offset
                || delta.pointer("/function/arguments").and_then(Value::as_str) == Some("")
            {
                self.projection
                    .call(observer, index as u64, name, Some(&arguments[offset..]));
            }
            *emitted = Some(arguments.len());
        }
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

/// Appends tool call deltas; false when one names an index at or past
/// [`MAX_TOOL_CALLS`] (a local server's stream must not grow memory).
fn merge_tool_calls(output: &mut Vec<Value>, deltas: &[Value]) -> bool {
    for delta in deltas {
        let index = delta
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .unwrap_or(0);
        if index >= MAX_TOOL_CALLS {
            return false;
        }
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
    true
}

fn append(target: &mut Value, pointer: &str, source: Option<&Value>) {
    let Some(fragment) = source.and_then(Value::as_str) else {
        return;
    };
    if let Some(Value::String(value)) = target.pointer_mut(pointer) {
        value.push_str(fragment);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Security boundary: streamed tool-call indexes are bounded, so a hostile or
    /// broken provider stream cannot make the agent allocate unbounded calls.
    // test-category: security
    #[test]
    fn tool_call_indexes_are_bounded() {
        let mut calls = Vec::new();
        assert!(merge_tool_calls(
            &mut calls,
            &[json!({"index": 1, "id": "call_1", "function": {"name": "read", "arguments": "{}"}})]
        ));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1]["function"]["name"], "read");
        assert!(!merge_tool_calls(
            &mut calls,
            &[json!({"index": MAX_TOOL_CALLS})]
        ));
        assert!(!merge_tool_calls(&mut calls, &[json!({"index": u64::MAX})]));
        assert_eq!(calls.len(), 2);
    }
}
