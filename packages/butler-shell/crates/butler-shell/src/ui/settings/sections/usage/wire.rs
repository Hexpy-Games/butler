//! What the page reads of `UsageMonitorView`, `UsageHistoryView`, `ProviderQuotaResultView` and
//! `ImageUsageView` (app/types.ts, usage/imageUsageTypes.ts).
use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::ui::composer::context::UsageMonitorView as Chart;

/// `GET /usage-monitor`: the page's fields, and the view the shared timeline reads.
pub(super) struct View {
    pub(super) usage: Monitor,
    pub(super) chart: Chart,
}

impl View {
    pub(super) fn decode(raw: &Value) -> Option<Self> {
        Some(Self {
            usage: Monitor::deserialize(raw).ok()?,
            chart: Chart::deserialize(raw).ok()?,
        })
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Monitor {
    pub(super) top_sessions: Vec<TopSession>,
    pub(super) previous_period: Option<Total>,
    pub(super) filters: Filters,
    pub(super) model: ModelUsage,
    pub(super) web_search: WebSearch,
    pub(super) tools: ToolUsage,
    pub(super) provider_usage: ProviderUsage,
    pub(super) cost: Cost,
    #[serde(rename = "generated_at")]
    pub(super) generated_at: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct TopSession {
    pub(super) session_id: String,
    pub(super) title: Option<String>,
    pub(super) kind: String,
    pub(super) total_tokens: f64,
    pub(super) last_used_ms: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Total {
    pub(super) total_tokens: f64,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Filters {
    pub(super) session_id: Option<String>,
}

/// `UsageTokenBucketView`
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct TokenTotals {
    pub(super) request_count: f64,
    pub(super) prompt_tokens: f64,
    pub(super) cached_tokens: f64,
    pub(super) total_tokens: f64,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ModelUsage {
    #[serde(flatten)]
    pub(super) totals: TokenTotals,
    pub(super) by_model: BTreeMap<String, TokenTotals>,
    pub(super) subtasks: Option<TokenTotals>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct WebSearch {
    pub(super) request_count: f64,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ToolUsage {
    pub(super) by_tool: BTreeMap<String, ToolCalls>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ToolCalls {
    pub(super) calls: f64,
    pub(super) failures: f64,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Cost {
    pub(super) available: bool,
    pub(super) estimated_usd: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ProviderUsage {
    pub(super) providers: Vec<ProviderEntry>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct ProviderEntry {
    pub(super) provider_id: String,
    pub(super) month_tokens: Option<f64>,
    pub(super) remaining: Quota,
}

/// `ProviderQuotaResultView`
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Quota {
    pub(super) available: bool,
    pub(super) stale: bool,
    pub(super) source_kind: String,
    pub(super) plan_kind: String,
    pub(super) plan_name: Option<String>,
    pub(super) plan_usage: Option<PlanUsage>,
    pub(super) windows: Vec<QuotaWindow>,
    pub(super) fetched_at: Option<String>,
    pub(super) reason: Option<Reason>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct PlanUsage {
    pub(super) state: String,
    pub(super) resets_at: Option<String>,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Reason {
    pub(super) code: String,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct QuotaWindow {
    pub(super) id: String,
    pub(super) remaining_percent: Option<f64>,
    pub(super) window_duration_mins: Option<f64>,
    pub(super) resets_at: Option<String>,
    pub(super) expires_at: Option<String>,
}

/// `GET /usage-history`
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct History {
    pub(super) lifetime_tokens: f64,
    pub(super) busiest_day: Option<BusiestDay>,
    pub(super) longest_task: Option<LongestTask>,
    pub(super) longest_streak: Streak,
    pub(super) current_streak: Streak,
    /// `[date, tokens]` per active day.
    pub(super) days: Vec<(String, f64)>,
    pub(super) prior_total: f64,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct BusiestDay {
    pub(super) date: String,
    pub(super) tokens: f64,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct LongestTask {
    pub(super) duration_ms: f64,
    pub(super) title: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Streak {
    pub(super) days: f64,
    pub(super) start: Option<String>,
    pub(super) end: Option<String>,
}

/// `ImageUsageView`
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct ImageUsage {
    pub(super) days: u32,
    pub(super) models: Vec<ImageModelUsage>,
    pub(super) total: ImageValues,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct ImageModelUsage {
    pub(super) model_ref: String,
    pub(super) display_name: String,
    pub(super) provider_id: String,
    #[serde(flatten)]
    pub(super) values: ImageValues,
}

#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct ImageValues {
    pub(super) generated: f64,
    pub(super) edited: f64,
    pub(super) estimated_usd: Option<f64>,
}
