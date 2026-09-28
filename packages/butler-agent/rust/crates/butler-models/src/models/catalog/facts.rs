//! Typed catalog facts copied from official provider documentation: the
//! model's tier in its provider lineup and which image limits the provider
//! documents versus which Butler imposes itself.

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
