//! Rolling Butler usage for one opaque ChatGPT registration.
use super::{
    UsageMonitorSources,
    log::{SLOT_MS, UsageLogIndex, slot_start},
    row::UsageRow,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};
const DAY: i64 = 86_400_000;
#[derive(Clone, Default)]
pub(super) struct PlanTokens {
    requests: u64,
    input: f64,
    cached: f64,
    output: f64,
    total: f64,
}
impl PlanTokens {
    pub(super) fn add(&mut self, row: &UsageRow) {
        self.requests += 1;
        self.input += row.prompt;
        self.cached += row.cached;
        self.total += row.total.unwrap_or_default();
        self.output += row.total.map_or(0.0, |total| (total - row.prompt).max(0.0));
    }
    fn merge(&mut self, other: &Self) {
        self.requests += other.requests;
        self.input += other.input;
        self.cached += other.cached;
        self.output += other.output;
        self.total += other.total;
    }
}
pub(super) fn account(row: &UsageRow) -> Option<&str> {
    let account = row.billing_account.as_deref()?;
    (row.auth_mode.as_deref() == Some("subscription")
        && butler_models::models::parse_model_ref(&row.model).provider_id == "openai")
        .then_some(account)
}

#[derive(Default)]
pub(super) struct PlanUsageIndex {
    slots: BTreeMap<i64, HashMap<Arc<str>, PlanTokens>>,
}
impl PlanUsageIndex {
    pub(super) fn push(&mut self, row: &UsageRow, now: i64) {
        let Some(account) = account(row) else {
            return;
        };
        let oldest = now.saturating_sub(31 * DAY);
        if row.ts < oldest as f64 {
            return;
        }
        let first = slot_start(oldest as f64);
        while self
            .slots
            .first_key_value()
            .is_some_and(|(slot, _)| *slot < first)
        {
            self.slots.pop_first();
        }
        self.slots
            .entry(slot_start(row.ts))
            .or_default()
            .entry(Arc::from(account))
            .or_default()
            .add(row);
    }
    pub(super) fn view(
        &self,
        account: &str,
        now: i64,
        mut boundary: impl FnMut(i64, i64) -> PlanTokens,
    ) -> Value {
        let windows: Vec<_> = [("hours_5",5 * 3_600_000),("days_7",7 * DAY),("days_30",30 * DAY)].into_iter().map(|(id, length)| {
            let start = now - length;
            let first = slot_start(start as f64);
            let last = slot_start(now as f64);
            let complete_start = if first == start { first } else { first + SLOT_MS };
            let mut tokens = PlanTokens::default();
            for (_, accounts) in self.slots.range(complete_start..last) {
                if let Some(value) = accounts.get(account) { tokens.merge(value); }
            }
            if first != start { tokens.merge(&boundary(start, first + SLOT_MS)); }
            tokens.merge(&boundary(last, now));
            json!({"id":id,"requests":tokens.requests,"inputTokens":tokens.input,"outputTokens":tokens.output,"totalTokens":tokens.total})
        }).collect();
        json!({"account":"chatgpt_plan","windows":windows,"asOf":chrono::DateTime::from_timestamp_millis(now).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis,true))})
    }
}
pub(super) fn include_provider(
    values: &mut BTreeMap<String, super::buckets::Tokens>,
    sources: Option<&UsageMonitorSources<'_>>,
) {
    if sources.and_then(|s| s.chatgpt_account.as_ref()).is_some() {
        values.entry("openai".into()).or_default();
    }
}

pub(super) fn attach(
    providers: &mut Value,
    log: &UsageLogIndex,
    sources: Option<&UsageMonitorSources<'_>>,
    now: f64,
) {
    let now = butler_core::json::saturating_i64(now);
    let Some(account) = sources.and_then(|s| s.chatgpt_account.as_deref()) else {
        return;
    };
    let Some(rows) = providers["providers"].as_array_mut() else {
        return;
    };
    if let Some(row) = rows.iter_mut().find(|row| row["providerId"] == "openai") {
        row["butlerUsage"] = log.plan_usage(account, now);
    }
}
