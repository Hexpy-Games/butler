//! The `/model-catalog` JSON model management reads (`ModelCatalogView`, `AppModelSummary`,
//! `ProviderCredentialView`) and `modelManagementUtils.ts`.
use butler_ds::ui::context::Lang;
use serde::{Deserialize, Deserializer};

use crate::ui::composer::menus::token_window_label;
use crate::ui::i18n::composer::menus::copy;
use crate::ui::settings::state::SettingsState;

pub(super) const LOCAL_PROVIDER_ID: &str = "local";
pub(super) const NEW_CREDENTIAL_ID: &str = "__new";
pub(super) const API_KEY: &str = "api_key";
pub(super) const CHATGPT_OAUTH: &str = "chatgpt_oauth";

/// A list the agent may send as `null`.
fn nullable<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// `AppModelSummary`: the fields management reads.
#[derive(Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct CatalogModel {
    pub(super) provider_id: String,
    pub(super) provider_label: String,
    pub(super) model_id: String,
    pub(super) model_ref: String,
    pub(super) display_name: Option<String>,
    pub(super) context_window_tokens: Option<f64>,
    pub(super) runtime_supported: bool,
    pub(super) platform: Option<String>,
    pub(super) auth_type: Option<String>,
    pub(super) credential_id: Option<String>,
    pub(super) credential_masked_value: Option<String>,
    pub(super) api_base_url: Option<String>,
}

impl CatalogModel {
    /// `modelDisplayName`
    pub(super) fn name(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.model_id)
    }

    /// `modelOptionLabel`
    pub(super) fn option_label(&self, lang: Lang) -> String {
        format!(
            "{} ({})",
            self.name(),
            token_window_label(self.context_window_tokens, copy(lang))
        )
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct CatalogProvider {
    pub(super) provider_id: String,
    pub(super) provider_label: String,
    #[serde(deserialize_with = "nullable")]
    auth_methods: Vec<String>,
    default_api_base_url: Option<String>,
    #[serde(deserialize_with = "nullable")]
    models: Vec<CatalogModel>,
}

/// `ProviderCredentialView`
#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Credential {
    pub(super) id: String,
    provider_id: String,
    pub(super) label: String,
    pub(super) masked_value: String,
    auth_type: String,
}

/// `ModelCatalogView`
#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct Catalog {
    #[serde(deserialize_with = "nullable")]
    providers: Vec<CatalogProvider>,
    #[serde(deserialize_with = "nullable")]
    models: Vec<CatalogModel>,
    #[serde(deserialize_with = "nullable")]
    pub(super) registered_models: Vec<CatalogModel>,
    #[serde(deserialize_with = "nullable")]
    provider_credentials: Vec<Credential>,
}

impl Catalog {
    /// The catalog the settings hold; `None` until `/model-catalog` lands.
    pub(super) fn read(state: &SettingsState) -> Option<Self> {
        Self::deserialize(state.catalog()?).ok()
    }

    /// `HostedImageModelForm` in `ImageModelAddPage.tsx` uses only saved API keys.
    pub(super) fn api_key_only(mut self) -> Self {
        self.provider_credentials
            .retain(|credential| credential.auth_type == API_KEY);
        self
    }

    /// `providerAuthMethods`
    pub(super) fn auth_methods(&self, provider_id: &str) -> Vec<String> {
        let methods = self
            .provider(provider_id)
            .map(|provider| provider.auth_methods.clone())
            .unwrap_or_default();
        if methods.is_empty() {
            vec![API_KEY.to_owned()]
        } else {
            methods
        }
    }

    /// `hostedModelProviders`
    pub(super) fn hosted_providers(&self) -> impl Iterator<Item = &CatalogProvider> {
        self.providers
            .iter()
            .filter(|provider| provider.provider_id != LOCAL_PROVIDER_ID)
    }

    /// `providerCredentials`
    pub(super) fn credentials(&self, provider_id: &str) -> Vec<&Credential> {
        self.provider_credentials
            .iter()
            .filter(|credential| credential.provider_id == provider_id)
            .collect()
    }

    /// `providerDefaultApiBaseUrl`
    pub(super) fn default_api_base_url(&self, provider_id: &str) -> &str {
        self.provider(provider_id)
            .and_then(|provider| provider.default_api_base_url.as_deref())
            .unwrap_or_default()
    }

    /// `providerModels`
    pub(super) fn models(&self, provider_id: &str) -> Vec<&CatalogModel> {
        let own = self
            .provider(provider_id)
            .map(|provider| provider.models.as_slice())
            .filter(|models| !models.is_empty());
        own.unwrap_or(&self.models)
            .iter()
            .filter(|model| model.provider_id == provider_id && model.runtime_supported)
            .collect()
    }

    fn provider(&self, provider_id: &str) -> Option<&CatalogProvider> {
        self.providers
            .iter()
            .find(|provider| provider.provider_id == provider_id)
    }
}
