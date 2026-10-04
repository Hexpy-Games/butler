//! Fresh configuration facts with shared immutable catalog metadata.
use super::*;

pub struct ModelContextMetadataRead {
    pub config: Value,
    pub catalog: Arc<ModelCatalogSnapshot>,
}

impl ModelConfiguration {
    /// Public metadata keeps its request-owned observation time and every field.
    pub async fn read_metadata(&self) -> Result<ModelMetadataRead, ModelCatalogError> {
        let metadata = self.read_context_metadata().await?;
        Ok(ModelMetadataRead {
            config: metadata.config,
            catalog: metadata.catalog.with_generated_at(self.clock.now_iso()),
        })
    }

    /// Context calculations borrow immutable facts, never the rendered catalog.
    /// Both configuration files are still read afresh at this request boundary.
    pub async fn read_context_metadata(
        &self,
    ) -> Result<ModelContextMetadataRead, ModelCatalogError> {
        let root = self.data_root.clone();
        let (config, credentials) = tokio::task::spawn_blocking(move || {
            (
                read_object_sync(&root.join("butler.config.json")),
                read_object_sync(&root.join(CREDENTIALS_FILE)),
            )
        })
        .await
        .map_err(|error| ModelCatalogError::Storage {
            message: "Model metadata could not be read.",
            source: error.into(),
        })?;
        let local = self.local_models(&config);
        let catalog = if local.is_empty() {
            self.registration_catalog.clone()
        } else {
            let default = configured_default(&config)
                .map(str::to_owned)
                .unwrap_or_else(|| self.catalog.default_preset(&config, &credentials).model);
            Arc::new(self.catalog.snapshot(
                ModelCatalogSnapshotInput {
                    configured_local: local.iter().map(ModelProviderMetadata::from).collect(),
                    extra_models: Vec::new(),
                    registered_models: Vec::new(),
                    credential_views: Vec::new(),
                    default_model_ref: Some(default),
                    generated_at: self.clock.now_iso(),
                },
                &self.collation,
            )?)
        };
        Ok(ModelContextMetadataRead { config, catalog })
    }
}
