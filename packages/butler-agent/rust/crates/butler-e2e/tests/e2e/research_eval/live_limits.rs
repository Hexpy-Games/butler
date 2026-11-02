use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) struct TaskBudget {
    pub max_usd: f64,
    pub max_calls: usize,
    pub usd: f64,
    pub calls: usize,
    pub runaway: bool,
    pub tools: BTreeMap<String, usize>,
}
impl Default for TaskBudget {
    fn default() -> Self {
        Self {
            max_usd: 2.0,
            max_calls: 400,
            usd: 0.0,
            calls: 0,
            runaway: false,
            tools: BTreeMap::new(),
        }
    }
}
impl TaskBudget {
    pub(super) fn from_env() -> Result<Self, HarnessError> {
        let mut budget = Self::default();
        if let Ok(value) = std::env::var("BUTLER_RESEARCH_EVAL_TASK_MAX_USD") {
            budget.max_usd = value
                .parse()
                .map_err(|_| HarnessError("invalid task spend limit".into()))?;
        }
        if let Ok(value) = std::env::var("BUTLER_RESEARCH_EVAL_TASK_MAX_CALLS") {
            budget.max_calls = value
                .parse()
                .map_err(|_| HarnessError("invalid task call limit".into()))?;
        }
        if !budget.max_usd.is_finite() || budget.max_usd <= 0.0 || budget.max_calls == 0 {
            return Err(HarnessError(
                "task limits must be positive and finite".into(),
            ));
        }
        Ok(budget)
    }
    pub(super) fn admit(&mut self) {
        self.calls += 1;
        self.runaway |= self.calls > self.max_calls;
    }
    pub(super) fn record_cost(&mut self, usd: f64) {
        self.usd += usd;
        self.runaway |= self.usd > self.max_usd;
    }
    pub(super) fn top_tools(&self) -> Value {
        let mut tools = self.tools.iter().collect::<Vec<_>>();
        tools.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
        json!(
            tools
                .into_iter()
                .take(5)
                .map(|(tool, count)| json!({"tool":tool,"count":count}))
                .collect::<Vec<_>>()
        )
    }
}

/// Aggregate model-emitted calls once per response, including fragmented SSE names.
pub(super) fn collect_tools(value: &Value, names: &mut BTreeMap<usize, String>) {
    let choice = &value["choices"][0];
    let calls = choice["delta"]["tool_calls"]
        .as_array()
        .or_else(|| choice["message"]["tool_calls"].as_array());
    for (index, call) in calls.into_iter().flatten().enumerate() {
        if let Some(name) = call["function"]["name"].as_str() {
            let index = call["index"]
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .unwrap_or(index);
            names.entry(index).or_default().push_str(name);
        }
    }
}
