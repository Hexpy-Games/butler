use serde::Deserialize;

use super::{ModelProviderMetadata, WorkerModelPreset};
use crate::models::ModelCatalogError;

#[cfg(test)]
pub(crate) const SOURCE_SHA256: &str =
    "93ba3b0ff44c3d79f3c975ec0d33057f62ebcafd4c873bd93e1eff0982414495";

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
