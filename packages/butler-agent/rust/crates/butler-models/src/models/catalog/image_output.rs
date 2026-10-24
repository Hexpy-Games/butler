//! Image-output facts are separate from chat admission and token pricing.
use super::ModelProviderMetadata;
use crate::models::ModelCatalogError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageOutputEndpoint {
    OpenaiImages,
    GeminiInteractions,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageMask {
    Alpha,
    None,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageSizeKind {
    Pixels,
    AspectRatio,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ImageOutputCapability {
    pub endpoint: ImageOutputEndpoint,
    pub edit: bool,
    pub mask: ImageMask,
    pub size_kind: ImageSizeKind,
    pub sizes: Vec<String>,
    pub qualities: Vec<String>,
    pub default_quality: String,
    pub transparent_background: bool,
    pub max_input_images: u32,
    pub pricing: ImageOutputPricing,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImageOutputPricing {
    Tokens {
        text_input_usd_per_mtok: f64,
        image_input_usd_per_mtok: f64,
        image_output_usd_per_mtok: f64,
        source_url: String,
        as_of: String,
    },
    PerImage {
        usd_by_quality: BTreeMap<String, f64>,
        source_url: String,
        as_of: String,
    },
}
impl ModelProviderMetadata {
    pub fn is_image_output(&self) -> bool {
        self.image_output.is_some()
            || self
                .output_modalities
                .as_ref()
                .is_some_and(|modalities| modalities.iter().any(|modality| modality == "image"))
    }
}
impl ImageOutputCapability {
    pub(super) fn validate(&self) -> Result<(), ModelCatalogError> {
        if !self.qualities.contains(&self.default_quality) {
            return Err(ModelCatalogError::rejected(
                "Image default quality is unavailable.",
            ));
        }
        Ok(())
    }
}
impl ImageOutputPricing {
    pub fn estimated_cost(
        &self,
        text: Option<u64>,
        input: Option<u64>,
        output: Option<u64>,
        quality: Option<&str>,
        images: u32,
    ) -> Option<f64> {
        match self {
            Self::Tokens {
                text_input_usd_per_mtok: t,
                image_input_usd_per_mtok: i,
                image_output_usd_per_mtok: o,
                ..
            } => {
                if text.is_none() && input.is_none() && output.is_none() {
                    return None;
                }
                Some(
                    (text.unwrap_or(0) as f64 * t
                        + input.unwrap_or(0) as f64 * i
                        + output.unwrap_or(0) as f64 * o)
                        / 1e6,
                )
            }
            Self::PerImage { usd_by_quality, .. } => usd_by_quality
                .get(quality?)
                .map(|cost| cost * f64::from(images)),
        }
    }
}

impl crate::models::ModelCatalog {
    pub fn image_output_models(&self) -> Vec<ModelProviderMetadata> {
        self.static_catalog
            .models
            .iter()
            .filter(|m| m.is_image_output())
            .cloned()
            .collect()
    }
}
