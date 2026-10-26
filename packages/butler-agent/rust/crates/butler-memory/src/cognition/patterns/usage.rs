//! Phase usage in the consolidation aggregator's shared numeric shape.
use butler_models::models::PromptUsageReport;
use serde_json::{Value, json};
use std::collections::BTreeSet;
#[derive(Default)]
pub(super) struct Usage {
    requests: u64,
    prompt: f64,
    cached: f64,
    output: f64,
    total: f64,
    models: BTreeSet<String>,
}
impl Usage {
    pub(super) fn push(&mut self, model: &str, report: Option<&PromptUsageReport>) {
        self.requests += 1;
        let reported = report
            .map(|r| r.model.as_str())
            .filter(|m| !m.is_empty())
            .unwrap_or(model);
        self.models.insert(reported.to_owned());
        if let Some(r) = report {
            let prompt = finite(r.prompt_tokens.unwrap_or(0.0));
            let output = finite(r.output_tokens);
            self.prompt += prompt;
            self.cached += finite(r.cached_tokens).min(prompt);
            self.output += output;
            self.total += finite(r.total_tokens.unwrap_or(prompt + output));
        }
    }
    pub(super) fn summary(self) -> Value {
        json!({"request_count":self.requests,"prompt_tokens":self.prompt,
            "cached_input_tokens":self.cached,"uncached_input_tokens":self.prompt - self.cached,
            "output_tokens":self.output,"total_tokens":self.total,"models":self.models,
            "raw_text_included":false})
    }
}
fn finite(value: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        0.0
    }
}
