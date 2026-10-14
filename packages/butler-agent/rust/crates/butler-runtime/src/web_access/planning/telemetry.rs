use std::time::Instant;

use butler_models::models::{ProviderPromptResult, ReasoningEffort};
use butler_turn::btcc::ProviderStreamObserver;
use parking_lot::Mutex;
use serde_json::{Value, json};

/// Counts only sizes and clocks; never retains prompts or streamed content.
pub(super) struct PlannerObserver {
    started: Instant,
    first_text_ms: Mutex<Option<u128>>,
}

impl PlannerObserver {
    pub(super) fn new() -> Self {
        Self {
            started: Instant::now(),
            first_text_ms: Mutex::new(None),
        }
    }

    pub(super) fn finish(
        &self,
        prompt: &str,
        instructions: &str,
        effort: ReasoningEffort,
        result: &ProviderPromptResult,
    ) -> Value {
        json!({
            "model":result.model,"reasoning_effort":effort,
            "prompt_bytes":prompt.len()+instructions.len(),"output_bytes":result.text.len(),
            "duration_ms":self.started.elapsed().as_millis(),
            "ttft_ms":*self.first_text_ms.lock(),
            "input_tokens":result.usage.as_ref().and_then(|usage| usage.prompt_tokens),
            "output_tokens":result.usage.as_ref().map(|usage| usage.output_tokens),
        })
    }
}

impl ProviderStreamObserver for PlannerObserver {
    fn event(&self, event: &Value) {
        let text = match event["type"].as_str() {
            Some("response.output_text.delta") => event["delta"].as_str(),
            Some("text_delta") => event["textDelta"].as_str(),
            Some("content_block_delta") => event["delta"]["text"].as_str(),
            _ => event
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str),
        };
        if text.is_some_and(|text| !text.is_empty()) {
            self.first_text_ms
                .lock()
                .get_or_insert_with(|| self.started.elapsed().as_millis());
        }
    }
}
