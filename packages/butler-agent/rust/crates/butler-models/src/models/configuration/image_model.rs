//! Install-wide image model selection and request-local secret leases.
use super::{ModelConfiguration, read_object};
use crate::models::{ImageOutputCapability, ModelProviderMetadata, ProviderAuthMethod};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Account credentials have a stable identity distinct from saved API keys.
const CHATGPT_IMAGE_CREDENTIAL: &str = "chatgpt_oauth";

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageModelSelection {
    pub model_ref: String,
    pub credential_id: String,
    pub default_quality: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct ImageModelError {
    pub code: &'static str,
}
fn invalid(code: &'static str) -> ImageModelError {
    ImageModelError { code }
}
fn storage(_: impl std::fmt::Display) -> ImageModelError {
    invalid("image_model_store_failed")
}

/// Never Debug or Serialize: the key lives only for this provider request.
pub struct ResolvedImageModel {
    pub metadata: ModelProviderMetadata,
    pub image_output: ImageOutputCapability,
    pub credential_id: String,
    pub default_quality: String,
    pub api_key: zeroize::Zeroizing<String>,
}

impl ModelConfiguration {
    pub async fn image_model_settings(&self) -> Result<Value, ImageModelError> {
        let read = self.read().await.map_err(storage)?;
        let credentials = &read.catalog.view().provider_credentials;
        let account = self.chatgpt_account().await.map_err(storage)?;
        let has_account = account.status != super::chatgpt::ChatGptAccountStatus::SignedOut;
        let models = read.catalog.image_output_models().into_iter().filter_map(|model| {
            let capability = model.image_output.as_ref()?;
            let mut keys = credentials.iter().filter(|key| key.provider_id == model.provider_id)
                .map(|key| json!({"id":key.id,"label":key.label,"masked_value":key.masked_value,
                    "auth_type":key.auth_type,"selectable":key.auth_type == ProviderAuthMethod::ApiKey,"reason":null}))
                .collect::<Vec<_>>();
            if model.provider_id == "openai" && has_account {
                keys.push(json!({"id":CHATGPT_IMAGE_CREDENTIAL,"label":account.label,
                    "masked_value":"","auth_type":"chatgpt_oauth","selectable":false,"reason":"chatgpt_sign_in"}));
            }
            let mut value = serde_json::to_value(capability).ok()?;
            let object = value.as_object_mut()?;
            object.remove("pricing");
            object.remove("endpoint");
            object.remove("max_input_images");
            object.insert("model_ref".into(), json!(model.model_ref));
            object.insert("model_id".into(), json!(model.model_id));
            object.insert("provider_id".into(), json!(model.provider_id));
            object.insert("provider_label".into(), json!(model.provider_label));
            object.insert("display_name".into(), json!(model.display_name));
            object.insert("credentials".into(), json!(keys));
            Some(value)
        }).collect::<Vec<_>>();
        let selected = read.config.pointer("/user/imageModel").cloned()
            .and_then(|v| serde_json::from_value::<ImageModelSelection>(v).ok())
            .and_then(|selection| {
                let model = read.catalog.image_output_models().into_iter()
                    .find(|model| model.model_ref == selection.model_ref)?;
                let quality = selection.default_quality.or_else(|| model.image_output.as_ref().map(|c| c.default_quality.clone()));
                let credential = credentials.iter().find(|key| key.id == selection.credential_id
                    && key.provider_id == model.provider_id && key.auth_type == ProviderAuthMethod::ApiKey);
                Some(json!({"model_ref":model.model_ref,"display_name":model.display_name,
                    "provider_id":model.provider_id,"credential_id":credential.map(|key| &key.id),"default_quality":quality}))
            });
        Ok(json!({"selected":selected,"models":models}))
    }

    pub async fn set_image_model(&self, input: Value) -> Result<Value, ImageModelError> {
        let guard = self.configuration_writes.acquire_owned().await;
        let selection = if input
            .as_object()
            .is_some_and(|o| o.len() == 1 && o.get("selected") == Some(&Value::Null))
        {
            None
        } else {
            let mut selection: ImageModelSelection =
                serde_json::from_value(input).map_err(|_| invalid("image_model_unknown"))?;
            let read = self.read().await.map_err(storage)?;
            let model = read
                .catalog
                .image_output_models()
                .into_iter()
                .find(|model| model.model_ref == selection.model_ref)
                .ok_or_else(|| invalid("image_model_unknown"))?;
            let capability = model
                .image_output
                .ok_or_else(|| invalid("image_model_unknown"))?;
            if selection.credential_id == CHATGPT_IMAGE_CREDENTIAL {
                return Err(invalid("image_model_requires_api_key"));
            }
            let key = read
                .catalog
                .view()
                .provider_credentials
                .iter()
                .find(|key| {
                    key.id == selection.credential_id && key.provider_id == model.provider_id
                })
                .ok_or_else(|| invalid("image_model_credential_invalid"))?;
            if key.auth_type != ProviderAuthMethod::ApiKey {
                return Err(invalid("image_model_requires_api_key"));
            }
            let quality = selection
                .default_quality
                .get_or_insert(capability.default_quality);
            if !capability.qualities.contains(quality) {
                return Err(invalid("image_model_quality_invalid"));
            }
            Some(selection)
        };
        let path = self.data_root.join("butler.config.json");
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            let _change = butler_core::configuration::lock_file(&path).map_err(storage)?;
            let mut config =
                butler_core::configuration::read_json_object(&path).map_err(storage)?;
            let object = butler_core::json::object_mut(&mut config);
            butler_core::json::object_field_mut(object, "user")
                .insert("imageModel".into(), json!(selection));
            butler_core::configuration::write_json_atomic(&path, &config).map_err(storage)
        })
        .await
        .map_err(storage)??;
        self.image_model_settings().await
    }

    pub async fn resolve_image_model(&self) -> Result<Option<ResolvedImageModel>, ImageModelError> {
        let config = read_object(&self.data_root.join("butler.config.json")).await;
        let Some(value) = config.pointer("/user/imageModel").filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let selection: ImageModelSelection =
            serde_json::from_value(value.clone()).map_err(storage)?;
        let read = self.read().await.map_err(storage)?;
        let metadata = read
            .catalog
            .image_output_models()
            .into_iter()
            .find(|m| m.model_ref == selection.model_ref)
            .ok_or_else(|| invalid("image_model_unknown"))?;
        let image_output = metadata
            .image_output
            .clone()
            .ok_or_else(|| invalid("image_model_unknown"))?;
        if selection.credential_id == CHATGPT_IMAGE_CREDENTIAL {
            return Err(invalid("image_model_requires_api_key"));
        }
        let record = read
            .credentials
            .iter()
            .find(|key| {
                key.id == selection.credential_id && key.provider_id == metadata.provider_id
            })
            .ok_or_else(|| invalid("image_model_credential_invalid"))?;
        if !read
            .catalog
            .view()
            .provider_credentials
            .iter()
            .any(|c| c.id == record.id && c.auth_type == ProviderAuthMethod::ApiKey)
        {
            return Err(invalid("image_model_requires_api_key"));
        }
        let mut metadata = metadata;
        let override_url = if metadata.provider_id == "openai" {
            self.environment.openai_base_url.as_ref()
        } else {
            self.environment
                .hosted_provider_base_urls
                .get(&metadata.provider_id)
        };
        if let Some(url) = override_url {
            metadata.api_base_url = Some(url.clone());
        }
        let default_quality = selection
            .default_quality
            .unwrap_or_else(|| image_output.default_quality.clone());
        if !image_output.qualities.contains(&default_quality) {
            return Err(invalid("image_model_quality_invalid"));
        }
        let api_key = self
            .credential_secret(&self.data_root, record)
            .await
            .map_err(storage)?
            .into_zeroizing();
        Ok(Some(ResolvedImageModel {
            metadata,
            image_output,
            credential_id: selection.credential_id,
            default_quality,
            api_key,
        }))
    }
}
