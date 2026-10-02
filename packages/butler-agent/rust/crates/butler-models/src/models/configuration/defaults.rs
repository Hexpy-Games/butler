use super::{ModelConfiguration, configured_default, read_object_sync};
use crate::models::{ModelCatalogError, ModelPreset};
impl ModelConfiguration {
    pub fn effective_default_model(&self) -> Result<String, ModelCatalogError> {
        let model = self.default_model_from(&self.data_root).model;
        if model.is_empty() {
            return Err(ModelCatalogError::rejected(
                "Connected provider has no default model.",
            ));
        }
        Ok(model)
    }
    pub(super) fn default_model_from(&self, root: &std::path::Path) -> ModelPreset {
        let config = read_object_sync(&root.join("butler.config.json"));
        let credentials = read_object_sync(&root.join(super::credentials::CREDENTIALS_FILE));
        let mut preset = self.catalog.default_preset(&config, &credentials);
        if let Some(model) = configured_default(&config) {
            preset.model = crate::models::parse_model_ref(model).canonical_ref;
        }
        preset
    }
}

/// A connected provider's routine model shares that provider's connection.
/// This request snapshot does not register a model or change saved choices.
pub(super) fn routine_registration(
    model: &str,
    registered: &[crate::models::RegisteredHostedModelConfig],
    credentials: &[super::credentials::CredentialRecord],
    catalog: &crate::models::ModelCatalogSnapshot,
) -> Option<crate::models::RegisteredHostedModelConfig> {
    use crate::models::{ProviderAuthMethod, RegisteredHostedModelConfig, parse_model_ref};
    let parsed = parse_model_ref(model);
    if catalog.routine_preset(&parsed.provider_id)?.model != model
        || registered.iter().any(|entry| entry.model_ref == model)
    {
        return None;
    }
    if let Some(connection) = registered
        .iter()
        .find(|entry| entry.provider_id == parsed.provider_id)
    {
        let mut routine = connection.clone();
        routine.model_id = parsed.model_id;
        routine.model_ref = model.into();
        routine.display_name = String::new();
        return Some(routine);
    }
    let credential = credentials
        .iter()
        .find(|entry| entry.provider_id == parsed.provider_id)?;
    Some(RegisteredHostedModelConfig {
        provider_id: parsed.provider_id.clone(),
        provider_label: parsed.provider_id,
        model_id: parsed.model_id,
        model_ref: model.into(),
        display_name: String::new(),
        auth_type: ProviderAuthMethod::ApiKey,
        credential_id: Some(credential.id.clone()),
        auth_profile: None,
        api_base_url: None,
        created_at: credential.created_at.clone(),
        updated_at: credential.updated_at.clone(),
        extensions: serde_json::Map::new(),
    })
}
