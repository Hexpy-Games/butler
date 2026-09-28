use serde::Deserialize;

use super::presets::StaticProviderEntry;
use super::{ModelPreset, ModelPricing, ModelProviderMetadata, WorkerModelPreset, lookup};
use crate::models::ModelCatalogError;

#[derive(Deserialize)]
pub(crate) struct StaticCatalog {
    pub(super) models: Vec<ModelProviderMetadata>,
    pub(crate) presets: Vec<WorkerModelPreset>,
    pub(super) providers: Vec<StaticProviderEntry>,
}

impl StaticCatalog {
    pub(crate) fn load() -> Result<Self, ModelCatalogError> {
        serde_json::from_str(include_str!("static-catalog.json"))
            .map_err(ModelCatalogError::Catalog)
    }

    /// The provider's static `presets.routine`.
    pub(crate) fn routine_preset(&self, provider_id: &str) -> Option<&ModelPreset> {
        self.providers
            .iter()
            .find(|entry| entry.provider_id == provider_id)
            .map(|entry| &entry.presets.routine)
    }

    /// The provider's presets, for the catalog view.
    pub(super) fn provider_presets(&self, provider_id: &str) -> Option<super::ProviderPresets> {
        self.providers
            .iter()
            .find(|entry| entry.provider_id == provider_id)
            .map(|entry| entry.presets.clone())
    }

    /// The static list price of a catalog model ref (or declared alias).
    pub(crate) fn pricing(&self, model_ref: &str) -> Option<ModelPricing> {
        lookup::find_model_metadata(Some(model_ref), &self.models)?.pricing
    }
}
