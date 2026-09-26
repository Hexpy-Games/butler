use serde::Deserialize;

use super::{ModelProviderMetadata, WorkerModelPreset};
use crate::models::ModelCatalogError;

#[derive(Deserialize)]
pub(crate) struct StaticCatalog {
    pub(super) models: Vec<ModelProviderMetadata>,
    pub(crate) presets: Vec<WorkerModelPreset>,
}

impl StaticCatalog {
    pub(crate) fn load() -> Result<Self, ModelCatalogError> {
        serde_json::from_str(include_str!("static-catalog.json"))
            .map_err(|error| ModelCatalogError::new(error.to_string()))
    }
}
