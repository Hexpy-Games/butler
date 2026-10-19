//! One bounded background pass for saved local models lacking image evidence.
use super::{ModelConfiguration, read_object};
use crate::models::{LocalModelConfig, ModelCatalogError};
use std::sync::Arc;

impl ModelConfiguration {
    pub async fn discover_missing_local_images(self: Arc<Self>) -> Result<(), ModelCatalogError> {
        let config = read_object(&self.data_root.join("butler.config.json")).await;
        let models = self.local_models(&config);
        let credentials = super::local_credentials::read(
            &self.data_root.join("auth/custom-model-credentials.json"),
        )
        .await?;
        // Sequential probes bound concurrency to one, and never recur while idle.
        for model in models
            .into_iter()
            .filter(|model| model.image_input.is_none() && model.image_discovery.is_none())
        {
            let result = super::discovery::image::probe(
                &self.client,
                &model.api_base_url,
                &model.model_id,
                model.platform,
                credentials.get(&model.model_ref).map(String::as_str),
            )
            .await;
            if let Some(result) = result {
                self.store_local_image_discovery(model, result).await?;
            }
        }
        Ok(())
    }

    async fn store_local_image_discovery(
        &self,
        original: LocalModelConfig,
        result: crate::models::LocalImageDiscovery,
    ) -> Result<(), ModelCatalogError> {
        let _write = self.configuration_writes.acquire().await;
        let _change = super::mutations::lock_config(&self.data_root).await?;
        let mut config = read_object(&self.data_root.join("butler.config.json")).await;
        let Some(models) = config
            .pointer_mut("/models/local")
            .and_then(serde_json::Value::as_array_mut)
        else {
            return Ok(());
        };
        let now = original.updated_at.clone();
        let original = serde_json::to_value(original).map_err(super::mutations::json_error)?;
        // A concurrent edit/removal wins over the startup snapshot.
        for value in models {
            let current = crate::models::normalize_local_model_config(value, &now)
                .and_then(|model| serde_json::to_value(model).ok());
            if current.as_ref() == Some(&original) {
                value["image_discovery"] =
                    serde_json::to_value(&result).map_err(super::mutations::json_error)?;
                break;
            }
        }
        let path = self.data_root.join("butler.config.json");
        tokio::task::spawn_blocking(move || super::mutations::write_json(&path, &config))
            .await
            .map_err(|source| ModelCatalogError::Storage {
                message: "Local image discovery write task failed.",
                source: source.into(),
            })?
    }
}
