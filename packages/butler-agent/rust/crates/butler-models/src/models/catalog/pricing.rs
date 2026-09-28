//! Model list prices from the providers' official price pages, and the
//! per-request estimate built on them.

use serde::{Deserialize, Serialize};

/// One price band of a model, in USD per million tokens. A `None` price is
/// not published: tokens of that kind make the estimate unknown.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct TokenPrices {
    /// Uncached input tokens.
    pub input_per_mtok_usd: f64,
    /// Input tokens served from the provider's prompt cache.
    #[serde(default)]
    pub cached_input_per_mtok_usd: Option<f64>,
    /// Input tokens written to the prompt cache (the 5-minute rate where the
    /// provider distinguishes cache lifetimes).
    #[serde(default)]
    pub cache_write_per_mtok_usd: Option<f64>,
    /// Input tokens written to a 1-hour prompt cache.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_1h_per_mtok_usd: Option<f64>,
    /// Output tokens, reasoning tokens included.
    pub output_per_mtok_usd: f64,
}

/// A higher price band for requests whose prompt exceeds a size.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PromptPriceTier {
    /// The band applies to requests with more input tokens than this (a
    /// provider's "≥ 200K" is `199999`, its "> 272K" is `272000`).
    pub above_input_tokens: u64,
    /// Prices within the band.
    #[serde(flatten)]
    pub prices: TokenPrices,
    /// The page stating the threshold, when it is not the price page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// Prices that replace a time-limited price after its last day.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct NextPrices {
    /// Prices for the shortest prompts.
    #[serde(flatten)]
    pub base: TokenPrices,
    /// Higher bands for longer prompts, ascending by threshold.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompt_tiers: Vec<PromptPriceTier>,
}

/// A model's list price from the provider's official price page.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ModelPricing {
    /// The provider publishes a per-token price for the model.
    Published {
        /// Prices for the shortest prompts.
        #[serde(flatten)]
        base: TokenPrices,
        /// Higher bands for longer prompts, ascending by threshold.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        prompt_tiers: Vec<PromptPriceTier>,
        /// Last day (`YYYY-MM-DD`, UTC) a time-limited price applies.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        valid_until: Option<String>,
        /// The published price from the day after `valid_until`; without
        /// it, requests after that day are unpriced.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next: Option<NextPrices>,
        /// The official price page.
        source_url: String,
        /// Date (`YYYY-MM-DD`) the price was read from the page.
        as_of: String,
    },
    /// No per-token price is published for this model on this route.
    Unknown {
        /// The page that was checked.
        source_url: String,
        /// Date (`YYYY-MM-DD`) the page was checked.
        as_of: String,
        /// Why no price applies, e.g. a subscription-billed plan.
        reason: String,
    },
}

/// Token counts of one provider request.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RequestTokens {
    /// Prompt tokens, cached and cache-written ones included.
    pub input: u64,
    /// Prompt tokens served from the prompt cache.
    pub cached: u64,
    /// Prompt tokens written to the prompt cache.
    pub cache_write: u64,
    /// The part of `cache_write` written to a 1-hour cache.
    pub cache_write_1h: u64,
    /// Output tokens, reasoning included.
    pub output: u64,
}

impl ModelPricing {
    /// The prices a request with `input_tokens` made on `day` (`YYYY-MM-DD`,
    /// UTC) is billed at, or `None` when no price applies.
    pub fn prices_at(&self, input_tokens: u64, day: &str) -> Option<TokenPrices> {
        let Self::Published {
            base,
            prompt_tiers,
            valid_until,
            next,
            ..
        } = self
        else {
            return None;
        };
        if valid_until.as_deref().is_some_and(|until| day > until) {
            let next = next.as_ref()?;
            return Some(band(&next.base, &next.prompt_tiers, input_tokens));
        }
        Some(band(base, prompt_tiers, input_tokens))
    }

    /// The date the published price was read, if one is published.
    pub fn as_of(&self) -> Option<&str> {
        match self {
            Self::Published { as_of, .. } => Some(as_of),
            Self::Unknown { .. } => None,
        }
    }
}

fn band(base: &TokenPrices, tiers: &[PromptPriceTier], input_tokens: u64) -> TokenPrices {
    tiers
        .iter()
        .rev()
        .find(|tier| input_tokens > tier.above_input_tokens)
        .map_or(*base, |tier| tier.prices)
}

impl TokenPrices {
    /// Estimated USD for one request, `None` when it has cached or
    /// cache-written tokens whose price is not published.
    pub fn estimate_usd(&self, tokens: &RequestTokens) -> Option<f64> {
        let cached = tokens.cached.min(tokens.input);
        let write = tokens.cache_write.min(tokens.input - cached);
        let write_1h = tokens.cache_write_1h.min(write);
        let uncached = tokens.input - cached - write;
        let cost = |count: u64, price: Option<f64>| match count {
            0 => Some(0.0),
            _ => price.map(|price| count as f64 * price),
        };
        let total = uncached as f64 * self.input_per_mtok_usd
            + cost(cached, self.cached_input_per_mtok_usd)?
            + cost(write - write_1h, self.cache_write_per_mtok_usd)?
            + cost(write_1h, self.cache_write_1h_per_mtok_usd)?
            + tokens.output as f64 * self.output_per_mtok_usd;
        Some(total / 1_000_000.0)
    }
}
