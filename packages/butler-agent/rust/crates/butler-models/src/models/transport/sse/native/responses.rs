use crate::models::stream_event::StreamProjection;
use butler_turn::btcc::ProviderStreamObserver;
use serde_json::Value;
use std::collections::HashSet;

pub(super) struct State {
    calls: HashSet<u64>,
    projection: StreamProjection,
}

impl State {
    pub(super) fn new() -> Self {
        Self {
            calls: HashSet::new(),
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
                let index = output_index(event)?;
                let item = &event["item"];
                self.projection.start(
                    observer,
                    index,
                    item["name"].as_str().unwrap_or(""),
                    item["call_id"].as_str(),
                );
                self.calls.insert(index);
            }
            "response.function_call_arguments.delta" => {
                let index = output_index(event)?;
                if !self.calls.contains(&index) {
                    return Err("provider_stream_malformed_event");
                }
                let fragment = event["delta"]
                    .as_str()
                    .ok_or("provider_stream_malformed_event")?;
                self.projection.delta(observer, index, fragment);
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

fn output_index(event: &Value) -> Result<u64, &'static str> {
    event["output_index"]
        .as_u64()
        .ok_or("provider_stream_malformed_event")
}
