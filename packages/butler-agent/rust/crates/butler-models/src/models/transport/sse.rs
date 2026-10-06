use futures_util::StreamExt;
use reqwest::Response;
use serde_json::{Map, Value};

use butler_turn::btcc::ProviderRequestError;

use super::super::provider::ProviderClock;
use super::super::{diagnostics, request_guard::RequestProgress};

mod chat;
pub(super) mod frame_size;
pub(super) use chat::hosted_chat;

pub(super) async fn codex(
    response: Response,
    provider: &str,
    api: &str,
    progress: RequestProgress,
    observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
    clock: &dyn ProviderClock,
) -> Result<Value, Box<ProviderRequestError>> {
    let mut state = CodexState::new(clock.now_epoch_millis());
    let completed = consume(response, provider, api, None, |frame| {
        let Ok(event) = serde_json::from_str::<Value>(frame) else {
            return Ok(None);
        };
        progress.record_progress();
        state.event(&event, observer, provider, api)
    })
    .await?;
    let completed = completed.ok_or_else(|| {
        Box::new(diagnostics::protocol(
            provider,
            api,
            "provider_stream_interrupted",
        ))
    })?;
    Ok(state.response(&completed, clock))
}

struct CodexState {
    output: Vec<Value>,
    fallback_text: String,
    sequence: u64,
    fallback_stream_id: String,
}

impl CodexState {
    fn new(now: i64) -> Self {
        Self {
            output: Vec::new(),
            fallback_text: String::new(),
            sequence: 0,
            fallback_stream_id: format!("codex-stream-{now}"),
        }
    }
    fn event(
        &mut self,
        event: &Value,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
        provider: &str,
        api: &str,
    ) -> Result<Option<Value>, Box<ProviderRequestError>> {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "error" || kind == "response.failed" {
            let error = event
                .get("error")
                .or_else(|| event.pointer("/response/error"))
                .unwrap_or(event);
            let code = error.get("code").and_then(Value::as_str).unwrap_or("");
            let kind = error.get("type").and_then(Value::as_str).unwrap_or("");
            let identity = format!("{kind}:{code}").to_ascii_lowercase();
            let status = if identity.contains("rate") || identity.contains("too_many_requests") {
                429
            } else if identity.contains("unauthorized") || identity.contains("auth") {
                401
            } else if identity.contains("permission") || identity.contains("forbidden") {
                403
            } else if identity.contains("invalid") || identity.contains("bad_request") {
                400
            } else if identity.contains("service_unavailable") || identity.contains("overload") {
                503
            } else {
                502
            };
            return Err(Box::new(diagnostics::http(
                provider,
                api,
                status,
                Some(error),
                None,
            )));
        }
        if kind == "response.output_text.delta" {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                self.fallback_text.push_str(delta);
                let sequence = self.next();
                self.emit(observer, &serde_json::json!({"type":"text_delta","streamId":self.stream_id(event),"sequence":sequence,"textDelta":delta,"target":"final_candidate","raw":event}));
            }
        } else if kind.contains("reasoning") && kind.ends_with(".delta") {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                let sequence = self.next();
                self.emit(observer, &serde_json::json!({"type":"reasoning_delta","streamId":self.stream_id(event),"sequence":sequence,"textDelta":delta,"charCount":delta.encode_utf16().count(),"raw":event}));
            }
        } else if kind == "response.function_call_arguments.delta" {
            if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                let sequence = self.next();
                self.emit(observer, &serde_json::json!({"type":"tool_call_delta","streamId":self.stream_id(event),"callIndex":event.get("output_index").and_then(Value::as_u64).unwrap_or(0),"sequence":sequence,"toolCallId":event.get("call_id").or_else(||event.get("item_id")),"argumentsDelta":delta,"argumentCharCount":delta.encode_utf16().count(),"publicState":"generating","raw":event}));
            }
        } else if kind == "response.output_item.done" {
            if let Some(item) = event.get("item").filter(|value| value.is_object()) {
                self.output.push(item.clone());
                if item.get("type").and_then(Value::as_str) == Some("function_call") {
                    let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");
                    let sequence = self.next();
                    self.emit(observer, &serde_json::json!({"type":"tool_call_delta","streamId":self.stream_id(event),"callIndex":event.get("output_index").and_then(Value::as_u64).unwrap_or(0),"sequence":sequence,"toolCallId":item.get("call_id"),"toolName":item.get("name"),"argumentCharCount":arguments.encode_utf16().count(),"publicState":"ready","raw":event}));
                }
            }
        } else if kind == "response.completed"
            && let Some(response) = event.get("response").filter(|value| value.is_object())
        {
            self.emit(observer, &serde_json::json!({"type":"completed","streamId":self.stream_id(event),"status":"completed","raw":event}));
            return Ok(Some(response.clone()));
        }
        Ok(None)
    }

    fn next(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }
    fn emit(
        &self,
        observer: Option<&dyn butler_turn::btcc::ProviderStreamObserver>,
        projection: &Value,
    ) {
        if let Some(observer) = observer {
            observer.event(projection);
        }
    }
    fn stream_id<'a>(&'a self, event: &'a Value) -> &'a str {
        event
            .get("response_id")
            .or_else(|| event.pointer("/response/id"))
            .or_else(|| event.get("item_id"))
            .and_then(Value::as_str)
            .unwrap_or(&self.fallback_stream_id)
    }
    fn response(mut self, completed: &Value, clock: &dyn ProviderClock) -> Value {
        if self.output.is_empty() {
            self.output = completed
                .get("output")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
        }
        let mut response = Map::new();
        response.insert(
            "id".into(),
            completed
                .get("id")
                .cloned()
                .filter(Value::is_string)
                .unwrap_or_else(|| Value::String(format!("codex-{}", clock.now_epoch_millis()))),
        );
        if let Some(model) = completed.get("model") {
            response.insert("model".into(), model.clone());
        }
        response.insert("output".into(), Value::Array(self.output));
        if !self.fallback_text.is_empty() {
            response.insert("output_text".into(), self.fallback_text.into());
        }
        if let Some(usage) = completed.get("usage") {
            let mut rebuilt = serde_json::json!({"input_tokens":usage.get("input_tokens"),"prompt_tokens":usage.get("input_tokens"),"total_tokens":usage.get("total_tokens"),"prompt_tokens_details":{"cached_tokens":usage.pointer("/input_tokens_details/cached_tokens"),"cache_write_tokens":usage.pointer("/input_tokens_details/cache_write_tokens")}});
            rebuilt["provider_cached_tokens_present"] = usage
                .pointer("/input_tokens_details/cached_tokens")
                .is_some()
                .into();
            // Reasoning tokens feed SessionView.usage; only the count is kept.
            if let Some(reasoning) = usage.pointer("/output_tokens_details/reasoning_tokens") {
                rebuilt["output_tokens_details"] =
                    serde_json::json!({ "reasoning_tokens": reasoning });
            }
            response.insert("usage".into(), rebuilt);
        }
        Value::Object(response)
    }
}

/// Processes frames immediately. Only the current unframed tail and carrier
/// accumulator remain live; Codex completion drops the unread response body.
async fn consume<F>(
    response: Response,
    provider: &str,
    api: &str,
    limit: Option<usize>,
    mut consume_frame: F,
) -> Result<Option<Value>, Box<ProviderRequestError>>
where
    F: FnMut(&str) -> Result<Option<Value>, Box<ProviderRequestError>>,
{
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    let mut start = 0;
    let mut scan = 0;
    let mut size = frame_size::FrameSize::default();
    let mut first_chunk = true;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|error| Box::new(diagnostics::network(provider, api, &error.to_string())))?;
        buffer.extend_from_slice(&chunk);
        if first_chunk && buffer.len() >= 3 {
            if buffer.starts_with(&[0xef, 0xbb, 0xbf]) {
                start = 3;
            }
            first_chunk = false;
        } else if first_chunk && ![0xef, 0xbb, 0xbf].starts_with(&buffer) {
            first_chunk = false;
        }
        scan = scan.max(start);
        while let Some((index, width)) = boundary(&buffer[scan..]) {
            let end = scan + index;
            check_limit(&mut size, &buffer[start..end], limit, provider, api)?;
            let frame = String::from_utf8_lossy(&buffer[start..end]);
            if let Some(data) = data(&frame)
                && let Some(result) = consume_frame(&data)?
            {
                return Ok(Some(result));
            }
            start = end + width;
            scan = start;
            size = frame_size::FrameSize::default();
        }
        // A delimiter can straddle chunks; only its last three bytes need
        // rescanning. Earlier unframed bytes have already been searched.
        scan = buffer.len().saturating_sub(3).max(start);
        check_limit(&mut size, &buffer[start..], limit, provider, api)?;
        if start > 64 * 1024 && start * 2 >= buffer.len() {
            buffer.drain(..start);
            scan -= start;
            start = 0;
        }
    }
    let tail = &buffer[start..];
    if !butler_core::public_text::trim_js_whitespace(&String::from_utf8_lossy(tail)).is_empty() {
        check_limit(&mut size, tail, limit, provider, api)?;
        let frame = String::from_utf8_lossy(tail);
        if let Some(data) = data(&frame)
            && let Some(result) = consume_frame(&data)?
        {
            return Ok(Some(result));
        }
    }
    Ok(None)
}

fn check_limit(
    size: &mut frame_size::FrameSize,
    frame: &[u8],
    limit: Option<usize>,
    provider: &str,
    api: &str,
) -> Result<(), Box<ProviderRequestError>> {
    if limit.is_some_and(|limit| size.decoded_bytes(frame) > limit) {
        return Err(Box::new(diagnostics::protocol(
            provider,
            api,
            "provider_stream_frame_too_large",
        )));
    }
    Ok(())
}

fn boundary(value: &[u8]) -> Option<(usize, usize)> {
    [&b"\r\n\r\n"[..], &b"\n\n"[..], &b"\r\r"[..]]
        .into_iter()
        .filter_map(|needle| {
            value
                .windows(needle.len())
                .position(|window| window == needle)
                .map(|index| (index, needle.len()))
        })
        .min_by_key(|(index, _)| *index)
}

fn data(frame: &str) -> Option<String> {
    let data = frame
        .split(['\r', '\n'])
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>()
        .join("\n");
    let data = butler_core::public_text::trim_js_whitespace(&data);
    (!data.is_empty()).then(|| data.to_owned())
}
