use crate::models::stream_event::StreamProjection;
use butler_turn::btcc::ProviderStreamObserver;
use serde_json::{Value, json};

pub(super) struct State {
    message: Value,
    blocks: Vec<Value>,
    arguments: Vec<String>,
    closed: Vec<bool>,
    /// A `message_delta` reported why the provider stopped generating.
    stopped: bool,
    projection: StreamProjection,
}

impl State {
    pub(super) fn new() -> Self {
        Self {
            message: Value::Null,
            blocks: Vec::new(),
            arguments: Vec::new(),
            closed: Vec::new(),
            stopped: false,
            projection: StreamProjection::new(),
        }
    }

    pub(super) fn event(
        &mut self,
        event: &Value,
        observer: Option<&dyn ProviderStreamObserver>,
    ) -> Result<Option<Value>, &'static str> {
        match event["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.message = event["message"].clone();
                if !self.message.is_object() {
                    return Err("provider_stream_malformed_event");
                }
            }
            "content_block_start" => self.start(event, observer)?,
            "content_block_delta" => self.delta(event, observer)?,
            "content_block_stop" => self.close(index(event)?, false)?,
            "message_delta" => {
                self.stopped |= event["delta"]["stop_reason"].is_string();
                super::extend(&mut self.message, &event["delta"]);
                super::extend(&mut self.message["usage"], &event["usage"]);
            }
            "message_stop" => {
                return self
                    .finish(true)
                    .map(Some)
                    .ok_or("provider_stream_interrupted");
            }
            _ => {}
        }
        Ok(None)
    }

    fn start(
        &mut self,
        event: &Value,
        observer: Option<&dyn ProviderStreamObserver>,
    ) -> Result<(), &'static str> {
        let index = index(event)?;
        if index != self.blocks.len() {
            return Err("provider_stream_malformed_event");
        }
        let block = &event["content_block"];
        if !block.is_object() {
            return Err("provider_stream_malformed_event");
        }
        if block["type"] == "tool_use" {
            self.projection.start(
                observer,
                index as u64,
                block["name"].as_str().unwrap_or(""),
                block["id"].as_str(),
            );
        }
        self.blocks.push(block.clone());
        self.arguments.push(String::new());
        self.closed.push(false);
        Ok(())
    }

    fn delta(
        &mut self,
        event: &Value,
        observer: Option<&dyn ProviderStreamObserver>,
    ) -> Result<(), &'static str> {
        let index = index(event)?;
        let block = self
            .blocks
            .get_mut(index)
            .ok_or("provider_stream_malformed_event")?;
        let delta = &event["delta"];
        let kind = delta["type"].as_str().unwrap_or("");
        if kind == "input_json_delta" {
            let fragment = delta["partial_json"]
                .as_str()
                .ok_or("provider_stream_malformed_event")?;
            self.arguments[index].push_str(fragment);
            // Server tools (web search, MCP) also stream input but are not
            // Butler calls: only a started `tool_use` has argument fragments.
            if block["type"] == "tool_use" {
                self.projection.delta(observer, index as u64, fragment);
            }
        } else if kind == "citations_delta" {
            if block.get("citations").is_none() {
                block["citations"] = json!([]);
            }
            if let Some(citations) = block["citations"].as_array_mut() {
                citations.push(delta["citation"].clone());
            }
        } else {
            let field = match kind {
                "text_delta" => "text",
                "thinking_delta" => "thinking",
                "signature_delta" => "signature",
                _ => return Ok(()),
            };
            let fragment = delta[field]
                .as_str()
                .ok_or("provider_stream_malformed_event")?;
            if block.get(field).is_none() {
                block[field] = "".into();
            }
            if let Some(Value::String(value)) = block.get_mut(field) {
                value.push_str(fragment);
            }
            if field != "signature" {
                self.projection
                    .text(observer, fragment, field == "thinking");
            }
        }
        Ok(())
    }

    /// The assembled message once the stream ended with `message_stop` and
    /// every block closed, or once the provider reported its stop reason. A
    /// response stopped at its output limit can leave its last block open and
    /// omit the terminator; it is complete, not interrupted.
    pub(super) fn finish(&mut self, terminated: bool) -> Option<Value> {
        let open = self.closed.contains(&false);
        if !self.message.is_object() || ((open || !terminated) && !self.stopped) {
            return None;
        }
        for index in 0..self.blocks.len() {
            if !self.closed[index] {
                self.close(index, true).ok()?;
            }
        }
        self.message["content"] = Value::Array(std::mem::take(&mut self.blocks));
        Some(self.message.take())
    }

    fn close(&mut self, index: usize, cut: bool) -> Result<(), &'static str> {
        let block = self
            .blocks
            .get_mut(index)
            .ok_or("provider_stream_malformed_event")?;
        if !self.arguments[index].is_empty() {
            match serde_json::from_str(&self.arguments[index]) {
                Ok(input) => block["input"] = input,
                // Keep malformed Butler arguments for the normal tool validation
                // path. A completed max_tokens response can cut off a tool call.
                Err(_) if block["type"] == "tool_use" => {
                    block["input"] = self.arguments[index].clone().into();
                }
                // Another block cut at the limit keeps the input it started with.
                Err(_) if cut => {}
                Err(_) => return Err("provider_stream_malformed_event"),
            }
        }
        self.closed[index] = true;
        Ok(())
    }
}

fn index(event: &Value) -> Result<usize, &'static str> {
    event["index"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or("provider_stream_malformed_event")
}
