use serde_json::{Value, json};

use crate::models::PromptUsageReport;

#[derive(Default)]
pub(super) struct Usage {
    requests: u64,
    prompt: f64,
    cached: f64,
    output: f64,
    total: f64,
    models: Vec<String>,
}

impl Usage {
    pub(super) fn push(&mut self, model: &str, report: Option<&PromptUsageReport>) {
        self.requests += 1;
        let reported = report
            .map(|value| value.model.as_str())
            .filter(|value| !value.is_empty())
            .unwrap_or(model);
        if !self.models.iter().any(|value| value == reported) {
            self.models.push(reported.to_owned());
        }
        if let Some(report) = report {
            if let Some(prompt) = report
                .prompt_tokens
                .filter(|value| value.is_finite() && *value >= 0.0)
            {
                self.prompt += prompt;
                self.cached += report.cached_tokens.max(0.0).min(prompt);
            }
            if let Some(total) = report
                .total_tokens
                .filter(|value| value.is_finite() && *value >= 0.0)
            {
                self.total += total;
                if let Some(prompt) = report.prompt_tokens {
                    self.output += (total - prompt).max(0.0);
                }
            }
        }
    }

    pub(super) fn value(&self) -> Value {
        let uncached = (self.prompt - self.cached).max(0.0);
        let credits =
            round((uncached * 125.0 + self.cached * 12.5 + self.output * 750.0) / 1_000_000.0);
        let usd = round((uncached * 5.0 + self.cached * 0.5 + self.output * 30.0) / 1_000_000.0);
        json!({
            "request_count":self.requests, "prompt_tokens":self.prompt,
            "cached_input_tokens":self.cached, "uncached_input_tokens":uncached,
            "output_tokens":self.output, "total_tokens":self.total,
            "models":self.models,
            "estimated_codex_5_5_credits":credits, "estimated_api_gpt_5_5_usd":usd,
            "rate_source":"openai_codex_rate_card_2026_05", "raw_text_included":false,
        })
    }
}

fn round(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}
