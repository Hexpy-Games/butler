//! Typed catalog facts copied from official provider documentation: the
//! model's tier in its provider lineup, its list price, and which image
//! limits the provider documents versus which Butler imposes itself.

use serde::{Deserialize, Serialize};

/// A model's position in its provider's lineup.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    /// The most capable (and most expensive) class of the lineup.
    Flagship,
    /// The everyday class: the speed, capability and price middle ground.
    Balanced,
    /// The fastest and cheapest class of the lineup.
    Efficient,
}

/// One price band of a model, in USD per million tokens.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct TokenPrices {
    /// Uncached input tokens.
    pub input_per_mtok_usd: f64,
    /// Input tokens served from the provider's prompt cache. `None` when the
    /// provider publishes no cache price; such tokens are priced as input.
    pub cached_input_per_mtok_usd: Option<f64>,
    /// Output tokens, reasoning tokens included.
    pub output_per_mtok_usd: f64,
}

/// A higher price band that applies when a request's prompt exceeds a size.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct PromptPriceTier {
    /// The band applies to requests with more input tokens than this.
    pub above_input_tokens: u64,
    /// Prices within the band.
    #[serde(flatten)]
    pub prices: TokenPrices,
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

impl ModelPricing {
    /// The prices of the band a request with `input_tokens` falls into, or
    /// `None` when no price is published.
    pub fn prices_for(&self, input_tokens: u64) -> Option<TokenPrices> {
        let Self::Published {
            base, prompt_tiers, ..
        } = self
        else {
            return None;
        };
        Some(
            prompt_tiers
                .iter()
                .rev()
                .find(|tier| input_tokens > tier.above_input_tokens)
                .map_or(*base, |tier| tier.prices),
        )
    }

    /// The date the published price was read, if one is published.
    pub fn as_of(&self) -> Option<&str> {
        match self {
            Self::Published { as_of, .. } => Some(as_of),
            Self::Unknown { .. } => None,
        }
    }
}

impl TokenPrices {
    /// Estimated USD for one request: uncached input, cached input and output.
    pub fn estimate_usd(&self, input_tokens: u64, cached_tokens: u64, output_tokens: u64) -> f64 {
        let cached = cached_tokens.min(input_tokens);
        let uncached = input_tokens - cached;
        let cached_price = self
            .cached_input_per_mtok_usd
            .unwrap_or(self.input_per_mtok_usd);
        (uncached as f64 * self.input_per_mtok_usd
            + cached as f64 * cached_price
            + output_tokens as f64 * self.output_per_mtok_usd)
            / 1_000_000.0
    }
}

/// A catalog image limit field.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageLimitField {
    /// `image_accepted_mime_types`.
    ImageAcceptedMimeTypes,
    /// `image_max_inline_bytes`.
    ImageMaxInlineBytes,
    /// `image_max_width`.
    ImageMaxWidth,
    /// `image_max_height`.
    ImageMaxHeight,
    /// `image_max_pixels`.
    ImageMaxPixels,
    /// `image_max_patches`.
    ImageMaxPatches,
}

/// Where each image limit of a catalog entry comes from.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct ImageLimitSources {
    /// Limits stated in the provider's documentation (`image_capability_source_url`).
    #[serde(default)]
    pub provider_documented: Vec<ImageLimitField>,
    /// Limits Butler imposes where the provider documents none (or a looser one).
    #[serde(default)]
    pub butler_internal_default: Vec<ImageLimitField>,
}
