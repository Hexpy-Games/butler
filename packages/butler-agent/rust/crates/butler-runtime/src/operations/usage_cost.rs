//! Token totals and list-price cost estimates over the prompt-usage log.
//!
//! Each `metrics/prompt-cache-usage.jsonl` row is one provider request. A
//! row is priced with its model's catalog price for that request's prompt
//! size and day. If any request cannot be priced (no published price, an
//! expired time-limited price, or cache tokens without a cache price) the
//! estimate is unavailable rather than partial.

mod session_index;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use butler_models::models::{ModelPricing, RequestTokens, UsageAuthMode};

pub use session_index::{SessionUsage, SessionUsageIndex, SessionUsageView};

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
    /// Prompt tokens, cached and cache-written ones included.
    pub prompt_tokens: f64,
    /// Prompt tokens served from the provider cache.
    #[serde(default)]
    pub cached_tokens: f64,
    /// Prompt tokens written to the provider cache, when reported.
    #[serde(default)]
    pub cache_write_tokens: Option<f64>,
    /// The part of `cache_write_tokens` written to a 1-hour cache.
    #[serde(default, rename = "cacheWrite1hTokens")]
    pub cache_write_1h_tokens: Option<f64>,
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
    /// The request's token counts.
    pub fn tokens(&self) -> RequestTokens {
        let input = whole(self.prompt_tokens);
        RequestTokens {
            input,
            cached: whole(self.cached_tokens).min(input),
            cache_write: self.cache_write_tokens.map_or(0, whole),
            cache_write_1h: self.cache_write_1h_tokens.map_or(0, whole),
            // Output (reasoning included): total minus prompt when reported.
            output: self
                .total_tokens
                .map_or(0, |total| whole(total - self.prompt_tokens)),
        }
    }

    /// The UTC day (`YYYY-MM-DD`) of the request.
    fn day(&self) -> String {
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(self.ts)
            .map(|time| time.format("%Y-%m-%d").to_string())
            .unwrap_or_default()
    }
}

fn whole(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        butler_core::json::saturating_u64(value.round())
    } else {
        0
    }
}

/// Why no cost estimate is available.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostReason {
    /// Cached or cache-written tokens of a model with no published cache price.
    CachePriceUnknown,
    /// A model with no published price, or whose time-limited price ended.
    PricingUnknown,
}

impl CostReason {
    /// The serde (`snake_case`) name.
    pub fn code(self) -> &'static str {
        match self {
            Self::CachePriceUnknown => "cache_price_unknown",
            Self::PricingUnknown => "pricing_unknown",
        }
    }
}

/// Estimated list-price cost of some usage.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct UsageCostView {
    /// Whether `usd` holds an estimate covering every request.
    pub available: bool,
    /// Estimated USD at catalog list prices; `None` when unavailable.
    pub usd: Option<f64>,
    /// Models whose every request was priced.
    pub priced_model_refs: Vec<String>,
    /// Why the estimate is unavailable.
    pub reason: Option<CostReason>,
    /// Latest price-page date among the priced models.
    #[serde(skip)]
    pub as_of: Option<String>,
}

/// Accumulates tokens and priced cost over usage rows.
#[derive(Clone, Default)]
pub struct UsageTotals {
    /// Requests added.
    pub request_count: u64,
    /// Prompt tokens, cached and cache-written ones included.
    pub input_tokens: u64,
    /// Prompt tokens served from the provider cache.
    pub cached_input_tokens: u64,
    /// Prompt tokens written to the provider cache.
    pub cache_write_tokens: u64,
    /// Output tokens, reasoning included.
    pub output_tokens: u64,
    /// Reasoning tokens; `None` when no request reported them.
    pub reasoning_tokens: Option<u64>,
    /// Epoch milliseconds of the latest request.
    pub last_ts: Option<i64>,
    usd: f64,
    priced: BTreeSet<String>,
    unpriced: BTreeSet<String>,
    reason: Option<CostReason>,
    as_of: Option<String>,
}

impl UsageTotals {
    /// Adds one row, priced with `pricing` (the model's catalog price).
    pub fn add(&mut self, event: &UsageEvent, pricing: Option<&ModelPricing>) {
        let tokens = event.tokens();
        self.request_count += 1;
        self.input_tokens += tokens.input;
        self.cached_input_tokens += tokens.cached;
        self.cache_write_tokens += tokens.cache_write;
        self.output_tokens += tokens.output;
        if let Some(reasoning) = event.reasoning_tokens {
            *self.reasoning_tokens.get_or_insert(0) += whole(reasoning);
        }
        self.last_ts = self.last_ts.max(Some(event.ts));
        match price(event, &tokens, pricing) {
            Ok(usd) => {
                self.usd += usd;
                self.priced.insert(event.model.clone());
                let as_of = pricing.and_then(ModelPricing::as_of).map(str::to_owned);
                self.as_of = self.as_of.clone().max(as_of);
            }
            Err(reason) => {
                self.unpriced.insert(event.model.clone());
                self.reason = self.reason.max(Some(reason));
            }
        }
    }

    /// The cost estimate over everything added.
    pub fn cost(&self) -> UsageCostView {
        let available = self.reason.is_none();
        UsageCostView {
            available,
            usd: available.then_some(self.usd),
            priced_model_refs: self.priced.difference(&self.unpriced).cloned().collect(),
            reason: self.reason,
            as_of: self.as_of.clone(),
        }
    }
}

fn price(
    event: &UsageEvent,
    tokens: &RequestTokens,
    pricing: Option<&ModelPricing>,
) -> Result<f64, CostReason> {
    let prices = pricing
        .and_then(|pricing| pricing.prices_at(tokens.input, &event.day()))
        .ok_or(CostReason::PricingUnknown)?;
    prices
        .estimate_usd(tokens)
        .ok_or(CostReason::CachePriceUnknown)
}

#[cfg(test)]
mod tests;
