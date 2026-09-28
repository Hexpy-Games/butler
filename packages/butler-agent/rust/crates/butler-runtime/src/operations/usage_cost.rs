//! Token totals and list-price cost estimates over the prompt-usage log.
//!
//! Each `metrics/prompt-cache-usage.jsonl` row is one provider request. A
//! row is priced with its model's catalog price band for that request's prompt
//! size; models without a published price are reported, not guessed.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use butler_core::json_lines::visit_json_lines;
use butler_models::models::{ModelPricing, UsageAuthMode};

const USAGE_FILE: &str = "metrics/prompt-cache-usage.jsonl";

/// One prompt-usage row, as written by `PromptUsageMetrics`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    /// Epoch milliseconds of the request.
    pub ts: i64,
    /// Model ref the request ran on.
    pub model: String,
    /// Usage scope, `btcc-guided:<runtime session id>` for conversation turns.
    pub scope: String,
    /// Prompt tokens, cached ones included.
    pub prompt_tokens: f64,
    /// Prompt tokens served from the provider cache.
    #[serde(default)]
    pub cached_tokens: f64,
    /// Prompt plus output tokens, when reported.
    #[serde(default)]
    pub total_tokens: Option<f64>,
    /// Reasoning tokens, when the provider reported them.
    #[serde(default)]
    pub reasoning_tokens: Option<f64>,
    /// How the request was billed (rows written before #241 have none).
    #[serde(default)]
    pub auth_mode: Option<UsageAuthMode>,
}

impl UsageEvent {
    fn input(&self) -> u64 {
        whole(self.prompt_tokens)
    }
    fn cached(&self) -> u64 {
        whole(self.cached_tokens).min(self.input())
    }
    /// Output tokens (reasoning included): total minus prompt when reported.
    fn output(&self) -> u64 {
        self.total_tokens
            .map_or(0, |total| whole(total - self.prompt_tokens))
    }
}

fn whole(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        butler_core::json::saturating_u64(value.round())
    } else {
        0
    }
}

/// Why a cost estimate is partial or missing.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostReason {
    /// Some models used have no published price; `usd` covers the priced ones.
    PartialPricing,
    /// None of the models used has a published price.
    PricingUnknown,
}

impl CostReason {
    /// The serde (`snake_case`) name.
    pub fn code(self) -> &'static str {
        match self {
            Self::PartialPricing => "partial_pricing",
            Self::PricingUnknown => "pricing_unknown",
        }
    }
}

/// Estimated list-price cost of some usage.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct UsageCostView {
    /// Whether `usd` holds an estimate.
    pub available: bool,
    /// Estimated USD at catalog list prices.
    pub usd: Option<f64>,
    /// Models whose usage is included in `usd`.
    pub priced_model_refs: Vec<String>,
    /// Set when the estimate is partial or missing.
    pub reason: Option<CostReason>,
    /// Latest price-page date among the priced models.
    #[serde(skip)]
    pub as_of: Option<String>,
}

/// Accumulates tokens and priced cost over usage rows.
#[derive(Default)]
pub struct UsageTotals {
    /// Requests added.
    pub request_count: u64,
    /// Prompt tokens, cached ones included.
    pub input_tokens: u64,
    /// Prompt tokens served from the provider cache.
    pub cached_input_tokens: u64,
    /// Output tokens, reasoning included.
    pub output_tokens: u64,
    /// Reasoning tokens; `None` when no request reported them.
    pub reasoning_tokens: Option<u64>,
    /// Epoch milliseconds of the latest request.
    pub last_ts: Option<i64>,
    usd: f64,
    priced: BTreeSet<String>,
    unpriced: BTreeSet<String>,
    as_of: Option<String>,
}

impl UsageTotals {
    /// Adds one row, priced with `pricing` (the model's catalog price).
    pub fn add(&mut self, event: &UsageEvent, pricing: Option<&ModelPricing>) {
        self.request_count += 1;
        self.input_tokens += event.input();
        self.cached_input_tokens += event.cached();
        self.output_tokens += event.output();
        if let Some(reasoning) = event.reasoning_tokens {
            *self.reasoning_tokens.get_or_insert(0) += whole(reasoning);
        }
        self.last_ts = self.last_ts.max(Some(event.ts));
        match pricing.and_then(|pricing| Some((pricing.prices_for(event.input())?, pricing))) {
            Some((prices, pricing)) => {
                self.usd += prices.estimate_usd(event.input(), event.cached(), event.output());
                self.priced.insert(event.model.clone());
                self.as_of = self.as_of.clone().max(pricing.as_of().map(str::to_owned));
            }
            None => {
                self.unpriced.insert(event.model.clone());
            }
        }
    }

    /// The cost estimate over everything added.
    pub fn cost(&self) -> UsageCostView {
        let reason = if self.priced.is_empty() && !self.unpriced.is_empty() {
            Some(CostReason::PricingUnknown)
        } else if !self.unpriced.is_empty() {
            Some(CostReason::PartialPricing)
        } else {
            None
        };
        let available = reason != Some(CostReason::PricingUnknown);
        UsageCostView {
            available,
            usd: available.then_some(self.usd),
            priced_model_refs: self.priced.iter().cloned().collect(),
            reason,
            as_of: self.as_of.clone(),
        }
    }
}

/// `SessionView.usage`: one conversation's tokens and estimated cost.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SessionUsageView {
    /// Prompt tokens, cached ones included.
    pub input_tokens: u64,
    /// Prompt tokens served from the provider cache.
    pub cached_input_tokens: u64,
    /// Output tokens, reasoning included.
    pub output_tokens: u64,
    /// `None` when no request of the session reported reasoning tokens.
    pub reasoning_tokens: Option<u64>,
    /// Provider requests counted.
    pub request_count: u64,
    /// List-price estimate of the tokens above.
    pub cost: UsageCostView,
    /// Time of the latest counted request, `None` before the first.
    pub updated_at: Option<String>,
}

/// Session usage plus the billing mode of its latest request per model.
pub struct SessionUsage {
    /// `SessionView.usage`.
    pub view: SessionUsageView,
    /// Billing mode of the latest request per model ref.
    pub auth_modes: BTreeMap<String, UsageAuthMode>,
}

/// Reads one runtime session's usage (its `btcc-guided:<id>` rows).
pub fn read_session_usage(
    data_root: &Path,
    runtime_session_id: &str,
    pricing: &dyn Fn(&str) -> Option<ModelPricing>,
) -> SessionUsage {
    let scope = format!("btcc-guided:{runtime_session_id}");
    let mut totals = UsageTotals::default();
    let mut prices = BTreeMap::<String, Option<ModelPricing>>::new();
    let mut auth_modes = BTreeMap::new();
    visit_json_lines(&data_root.join(USAGE_FILE), |value| {
        let Ok(event) = UsageEvent::deserialize(value) else {
            return;
        };
        if event.scope != scope {
            return;
        }
        let price = prices
            .entry(event.model.clone())
            .or_insert_with(|| pricing(&event.model));
        totals.add(&event, price.as_ref());
        if let Some(mode) = event.auth_mode {
            auth_modes.insert(event.model.clone(), mode);
        }
    });
    SessionUsage {
        view: SessionUsageView {
            input_tokens: totals.input_tokens,
            cached_input_tokens: totals.cached_input_tokens,
            output_tokens: totals.output_tokens,
            reasoning_tokens: totals.reasoning_tokens,
            request_count: totals.request_count,
            cost: totals.cost(),
            updated_at: totals.last_ts.and_then(iso),
        },
        auth_modes,
    }
}

fn iso(epoch_ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(epoch_ms)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests;
