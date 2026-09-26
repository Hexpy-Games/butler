use super::*;
use std::sync::Mutex;

pub(super) struct Scratch(pub PathBuf);

impl Scratch {
    pub(super) fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-prompt-metrics-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    pub(super) fn path(&self) -> PathBuf {
        self.0.join("metrics/prompt-cache-usage.jsonl")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) struct Clock(pub Arc<Mutex<Vec<&'static str>>>);

impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        self.0.lock().unwrap().push("clock");
        1_789_344_000_123
    }
}

pub(super) struct BudgetSource {
    pub events: Arc<Mutex<Vec<&'static str>>>,
    pub result: Result<Option<PromptUsageBudgetState>, ModelRoundError>,
}

impl PromptBudgetStateSource for BudgetSource {
    fn snapshot(&self) -> Result<Option<PromptUsageBudgetState>, ModelRoundError> {
        self.events.lock().unwrap().push("budget");
        self.result.clone()
    }
}

pub(super) fn input<'a>() -> PromptUsageMetricInput<'a> {
    PromptUsageMetricInput {
        model: "openai/gpt-5.5",
        scope: "프로필\nextract",
        prompt_tokens: Some(120.0),
        cached_tokens: -3.0,
        total_tokens: None,
        cache_write_tokens: None,
        prompt_cache_key: None,
        prompt_cache_retention: None,
        butler_data: None,
        usage_attribution: None,
    }
}

pub(super) fn attribution<'a>() -> PromptUsageAttribution<'a> {
    PromptUsageAttribution {
        turn_id: None,
        phase: None,
        round_index: None,
        reasoning_effort: None,
        requested_output_tokens: None,
        budget_state: None,
        budget_state_source: None,
        prompt_sections: None,
    }
}

pub(super) fn budget() -> PromptUsageBudgetState {
    PromptUsageBudgetState {
        status: "warning".into(),
        request_count: 2.0,
        max_requests: 5.0,
        prompt_tokens: Some(120.0),
        cached_tokens: Some(20.0),
        output_tokens: Some(10.0),
        total_tokens: Some(130.0),
        max_prompt_tokens: Some(1_000.0),
        max_output_tokens: Some(300.0),
        max_total_tokens: Some(1_300.0),
        cumulative_request_count: Some(7.0),
        cumulative_prompt_tokens: Some(500.0),
        cumulative_cached_tokens: Some(50.0),
        cumulative_output_tokens: Some(60.0),
        cumulative_total_tokens: Some(560.0),
        stop_reason: Some("기준 😀".into()),
    }
}
