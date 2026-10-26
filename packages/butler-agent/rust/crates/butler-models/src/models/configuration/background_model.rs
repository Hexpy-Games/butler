use super::ModelConfiguration;
use super::settings::SettingsError;
use crate::models::{ParsedModelRefSource, parse_model_ref};
use butler_core::configuration;
use serde_json::Value;

impl ModelConfiguration {
    /// Mirror the App's validated background choice for config-file readers.
    pub async fn set_background_model(&self, requested: Option<&str>) -> Result<(), SettingsError> {
        let model = requested.map(parse_model_ref);
        if let Some(model) = &model {
            if model.source != ParsedModelRefSource::Namespaced || model.model_id.is_empty() {
                return Err(SettingsError::Rejected(
                    "model set requires canonical provider/model ref",
                ));
            }
            if self
                .registration_catalog
                .image_output_models()
                .iter()
                .any(|entry| entry.model_ref == model.canonical_ref)
            {
                return Err(SettingsError::Rejected(
                    "An image model cannot be the chat model.",
                ));
            }
        }
        let guard = self.configuration_writes.acquire_owned().await;
        let path = self.data_root.join("butler.config.json");
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let _change = configuration::lock_file(&path)?;
            let mut config = configuration::read_json_object(&path)?;
            let root = butler_core::json::object_mut(&mut config);
            butler_core::json::object_field_mut(root, "system").insert(
                "backgroundModel".into(),
                model
                    .map(|model| Value::String(model.canonical_ref))
                    .unwrap_or(Value::Null),
            );
            configuration::write_json_atomic(&path, &config)?;
            Ok(())
        })
        .await
        .map_err(SettingsError::WriteTask)?
    }
}
