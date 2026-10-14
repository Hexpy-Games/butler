use crate::models::stream_event::StreamProjection;
use butler_turn::btcc::ProviderStreamObserver;
use serde_json::Value;
use std::collections::HashMap;

pub(super) struct State {
    calls: HashMap<u64, Value>,
    projection: StreamProjection,
}

impl State {
    pub(super) fn new() -> Self {
        Self {
            calls: HashMap::new(),
            projection: StreamProjection::new(),
        }
    }

    pub(super) fn event(
        &mut self,
        event: &Value,
        observer: Option<&dyn ProviderStreamObserver>,
    ) -> Result<Option<Value>, &'static str> {
        match event["type"].as_str().unwrap_or("") {
            "response.output_item.added" if event["item"]["type"] == "function_call" => {
                let index = event["output_index"]
                    .as_u64()
                    .ok_or("provider_stream_malformed_event")?;
                let item = &event["item"];
                self.projection
                    .call(observer, index, item["name"].as_str().unwrap_or(""), None);
                self.calls.insert(index, item.clone());
            }
            "response.function_call_arguments.delta" => {
                let index = event["output_index"]
                    .as_u64()
                    .ok_or("provider_stream_malformed_event")?;
                let item = self
                    .calls
                    .get(&index)
                    .ok_or("provider_stream_malformed_event")?;
                let fragment = event["delta"]
                    .as_str()
                    .ok_or("provider_stream_malformed_event")?;
                self.projection.call(
                    observer,
                    index,
                    item["name"].as_str().unwrap_or(""),
                    Some(fragment),
                );
            }
            "response.output_text.delta" => {
                if let Some(text) = event["delta"].as_str() {
                    self.projection.text(observer, text, false);
                }
            }
            kind if kind.contains("reasoning") && kind.ends_with(".delta") => {
                if let Some(text) = event["delta"].as_str() {
                    self.projection.text(observer, text, true);
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response = &event["response"];
                if !response.is_object() {
                    return Err("provider_stream_malformed_event");
                }
                // The terminal Response is authoritative, including status and full usage.
                return Ok(Some(response.clone()));
            }
            _ => {}
        }
        Ok(None)
    }
}
