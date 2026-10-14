use crate::models::stream_event::{StreamProjection, gemini_call_id};
use butler_turn::btcc::ProviderStreamObserver;
use serde_json::{Value, json};

pub(super) struct State {
    response: Value,
    projection: StreamProjection,
    finished: bool,
    round: u32,
}

impl State {
    pub(super) fn new(round: u32) -> Self {
        Self {
            response: json!({"candidates":[]}),
            projection: StreamProjection::new(),
            finished: false,
            round,
        }
    }

    pub(super) fn event(
        &mut self,
        event: &Value,
        observer: Option<&dyn ProviderStreamObserver>,
    ) -> Result<Option<Value>, &'static str> {
        let fields = event.as_object().ok_or("provider_stream_malformed_event")?;
        for (key, value) in fields {
            if key != "candidates" {
                self.response[key] = value.clone();
            }
        }
        if event.pointer("/promptFeedback/blockReason").is_some() {
            self.finished = true;
        }
        for candidate in event["candidates"].as_array().into_iter().flatten() {
            let index = usize::try_from(candidate["index"].as_u64().unwrap_or(0))
                .map_err(|_| "provider_stream_malformed_event")?;
            let output = self.response["candidates"]
                .as_array_mut()
                .ok_or("provider_stream_malformed_event")?;
            if index > output.len() {
                return Err("provider_stream_malformed_event");
            }
            if index == output.len() {
                output.push(json!({"content":{"parts":[]}}));
            }
            let target = &mut output[index];
            for (key, value) in candidate
                .as_object()
                .ok_or("provider_stream_malformed_event")?
            {
                if key != "content" {
                    target[key] = value.clone();
                }
            }
            if index == 0 && candidate["finishReason"].is_string() {
                self.finished = true;
            }
            if let Some(content) = candidate.get("content").and_then(Value::as_object) {
                for (key, value) in content {
                    if key != "parts" {
                        target["content"][key] = value.clone();
                    }
                }
            }
            for (part_index, part) in candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let parts = target["content"]["parts"]
                    .as_array_mut()
                    .ok_or("provider_stream_malformed_event")?;
                absorb_part(
                    parts,
                    part,
                    if index == 0 { observer } else { None },
                    &mut self.projection,
                    (part_index == 0, self.round),
                );
            }
        }
        Ok(None)
    }

    pub(super) fn finish(self) -> Option<Value> {
        self.finished.then_some(self.response)
    }
}

fn absorb_part(
    parts: &mut Vec<Value>,
    part: &Value,
    observer: Option<&dyn ProviderStreamObserver>,
    projection: &mut StreamProjection,
    (continuing, round): (bool, u32),
) {
    if let Some(text) = part["text"].as_str() {
        projection.text(observer, text, part["thought"] == true);
        // Text is split by transport chunks, not logical part boundaries.
        if let Some(last) = parts.last_mut().filter(|last| {
            continuing
                && last["text"].is_string()
                && last["thought"] == part["thought"]
                && last
                    .get("thoughtSignature")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
        }) {
            if let Some(Value::String(value)) = last.get_mut("text") {
                value.push_str(text);
            }
            for (key, value) in part.as_object().into_iter().flatten() {
                if key != "text" {
                    last[key] = value.clone();
                }
            }
            return;
        }
    }
    if let Some(call) = part.get("functionCall") {
        let index = parts.len();
        let name = call["name"].as_str().unwrap_or("");
        // Gemini names no call id; the executed call gets this one.
        let id = gemini_call_id(round, index, name);
        projection.start(observer, index as u64, name, Some(&id));
        // GenerateContent emits complete function-call parts rather than raw JSON tokens.
        let empty = json!({});
        let arguments = call.get("args").unwrap_or(&empty);
        if let Ok(arguments) = butler_core::json::stringify(arguments) {
            projection.delta(observer, index as u64, &arguments);
        }
    }
    parts.push(part.clone());
}
