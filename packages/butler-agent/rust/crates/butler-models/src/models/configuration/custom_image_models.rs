//! User image endpoints share the OpenAI wire and the credential vault.
use super::credential_admin::CredentialDraft;
use super::credentials::{CREDENTIALS_FILE, PendingRemoval, SecretHome};
use super::image_model::{ImageModelError, invalid, storage};
use super::{ModelConfiguration, ModelConfigurationRead};
use crate::models::ModelProviderMetadata;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct CustomImageModel {
    id: String,
    display_name: String,
    api_base_url: String,
    model_id: String,
    credential_id: Option<String>,
}
#[derive(Deserialize)]
struct Input {
    display_name: String,
    api_base_url: String,
    model_id: String,
    api_key: Option<String>,
}
fn entries(config: &Value) -> Result<Vec<CustomImageModel>, ImageModelError> {
    config
        .pointer("/user/customImageModels")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(storage)
        .map(Option::unwrap_or_default)
}
pub(super) fn models(
    read: &ModelConfigurationRead,
) -> Result<Vec<ModelProviderMetadata>, ImageModelError> {
    let mut models = read.catalog.image_output_models();
    for entry in entries(&read.config)? {
        models.push(serde_json::from_value(json!({
            "provider_id":"custom-image","provider_label":"Custom","model_id":entry.model_id,
            "model_ref":format!("custom-image/{}",entry.id),"display_name":entry.display_name,
            "api_base_url":entry.api_base_url,"credential_id":entry.credential_id,
            "status":"ok","default_reasoning_effort":"none","reasoning_efforts":["none"],
            "token_estimator":"character_estimate","source_url":"","runtime_supported":false,
            "output_modalities":["image"],"image_output":{
                "endpoint":"openai_images","edit":true,"mask":"alpha","size_kind":"pixels",
                "sizes":["auto","1024x1024","1536x1024","1024x1536"],"qualities":[],
                "default_quality":null,"transparent_background":false,"max_input_images":16,"pricing":null
            }
        })).map_err(storage)?);
    }
    Ok(models)
}
impl ModelConfiguration {
    pub async fn add_custom_image_model(&self, value: Value) -> Result<Value, ImageModelError> {
        let input: Input =
            serde_json::from_value(value).map_err(|_| invalid("image_model_custom_invalid"))?;
        let url = reqwest::Url::parse(input.api_base_url.trim())
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some());
        if input.display_name.trim().is_empty() || input.model_id.trim().is_empty() || url.is_none()
        {
            return Err(invalid("image_model_custom_invalid"));
        }
        let write = self.configuration_writes.acquire_owned().await;
        let credential_id =
            if let Some(key) = input.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
                let (_lock, mut file) = self
                    .open_credentials(&self.data_root)
                    .await
                    .map_err(storage)?;
                let draft = CredentialDraft {
                    id: format!("cred_{}", uuid::Uuid::new_v4()),
                    provider_id: "custom-image".into(),
                    label: input.display_name.trim().into(),
                    created_at: self.clock.now_iso(),
                };
                Some(
                    self.write_credential(&self.data_root, &mut file, draft, key, None)
                        .await
                        .map_err(storage)?
                        .id,
                )
            } else {
                None
            };
        let entry = CustomImageModel {
            id: uuid::Uuid::new_v4().to_string(),
            display_name: input.display_name.trim().into(),
            api_base_url: input.api_base_url.trim().into(),
            model_id: input.model_id.trim().into(),
            credential_id,
        };
        self.save_custom_image_change(Some(entry), String::new())
            .await?;
        drop(write);
        self.image_model_settings().await
    }
    pub async fn delete_custom_image_model(&self, id: String) -> Result<Value, ImageModelError> {
        let write = self.configuration_writes.acquire_owned().await;
        let read = self.read().await.map_err(storage)?;
        let entry = entries(&read.config)?
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| invalid("image_model_unknown"))?;
        let (_lock, mut file) = self
            .open_credentials(&self.data_root)
            .await
            .map_err(storage)?;
        self.save_custom_image_change(None, id).await?;
        if let Some(id) = entry.credential_id {
            let records = file.records(&self.registration_catalog, self.clock.as_ref());
            if let Some(record) = records
                .iter()
                .find(|record| record.id == id && record.provider_id == "custom-image")
            {
                file.remove(&id);
                if let SecretHome::Store(backend) = record.home {
                    file.schedule_removal(&PendingRemoval {
                        backend,
                        provider_id: record.provider_id.clone(),
                        id,
                    });
                }
                file.save(&self.data_root.join(CREDENTIALS_FILE))
                    .map_err(storage)?;
                self.flush_removals(&self.data_root, &mut file).await;
            }
        }
        drop(write);
        self.image_model_settings().await
    }
    async fn save_custom_image_change(
        &self,
        entry: Option<CustomImageModel>,
        id: String,
    ) -> Result<(), ImageModelError> {
        let path = self.data_root.join("butler.config.json");
        tokio::task::spawn_blocking(move || {
            let _lock = butler_core::configuration::lock_file(&path).map_err(storage)?;
            let mut config =
                butler_core::configuration::read_json_object(&path).map_err(storage)?;
            let mut models = entries(&config)?;
            let selection = if let Some(entry) = entry {
                models.push(entry);
                None
            } else {
                models.retain(|entry| entry.id != id);
                (config
                    .pointer("/user/imageModel/model_ref")
                    .and_then(Value::as_str)
                    == Some(format!("custom-image/{id}").as_str()))
                .then_some(Value::Null)
            };
            let user = butler_core::json::object_field_mut(
                butler_core::json::object_mut(&mut config),
                "user",
            );
            user.insert("customImageModels".into(), json!(models));
            if let Some(selection) = selection {
                user.insert("imageModel".into(), selection);
            }
            butler_core::configuration::write_json_atomic(&path, &config).map_err(storage)
        })
        .await
        .map_err(storage)?
    }
}
