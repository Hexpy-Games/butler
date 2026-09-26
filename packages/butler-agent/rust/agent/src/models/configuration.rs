//! Native filesystem model facts. Snapshots belong to their caller, not a cache.

mod admission;
mod auth;
mod credentials;
mod discovery;
mod environment;
mod local_credentials;
mod mcp;
mod mutations;
mod probes;
mod provider;
mod read;
mod settings;

pub(crate) use auth::{AuthError as ModelAuthError, OpenAiAuthProfile};
pub(crate) use auth::{generate_pkce_verifier, pkce_challenge};
pub(crate) use discovery::{DiscoveredLocalModel, LocalModelDiscoveryResult};
pub(crate) use mcp::McpModelTarget;
pub(crate) use mutations::{HostedModelMutation, LocalModelMutation, ProviderCredentialMutation};

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use reqwest::Client;
use serde_json::Value;

use super::{
    LocalModelConfig, LocalModelPlatform, ModelCatalog, ModelCatalogError, ModelCatalogSnapshot,
    ModelCatalogSnapshotInput, ModelProviderMetadata, RegisteredHostedModelConfig,
    normalize_hosted_api_base_url, normalize_local_model_config, normalize_registered_hosted_model,
    registered_hosted_model_metadata,
};
use crate::configuration::ConfigurationWrites;
use crate::locale::LocaleCollation;

use credentials::CredentialRecord;
use environment::merge_private_auth_environment;
use read::{
    app_default, array, configured_default, first_by_key, read_object, read_object_sync, text,
};

pub(crate) trait ModelConfigurationClock: Send + Sync {
    fn now_iso(&self) -> String;
    fn now_epoch_millis(&self) -> i64;
}

/// Host-resolved process facts. No model request can mutate the environment.
#[derive(Clone, Default)]
pub(crate) struct ModelConfigurationEnvironment {
    pub openai_model: Option<String>,
    pub openai_reasoning_effort: Option<String>,
    pub codex_base_url: Option<String>,
    pub retry_attempts: Option<String>,
    pub provider_retry_base_delay_ms: Option<String>,
    pub openai_api_key: Option<String>,
    pub openai_base_url: Option<String>,
    pub provider_round_timeout_ms: Option<String>,
    pub provider_round_idle_timeout_ms: Option<String>,
    pub openai_prompt_cache_key_prefix: Option<String>,
    pub openai_prompt_cache_retention: Option<String>,
    pub butler_codex_auth_profile: Option<PathBuf>,
    pub butler_openai_auth_profile: Option<PathBuf>,
    pub codex_auth_json: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub oauth_authorize_url: Option<String>,
    pub oauth_token_url: Option<String>,
    pub oauth_client_id: Option<String>,
    pub oauth_scope: Option<String>,
    pub oauth_originator: Option<String>,
    pub codex_user_agent: Option<String>,
    pub os_platform: Option<String>,
    pub os_release: Option<String>,
    pub os_arch: Option<String>,
    pub hosted_provider_base_urls: HashMap<String, String>,
}

pub(crate) struct ModelConfiguration {
    data_root: PathBuf,
    environment: ModelConfigurationEnvironment,
    clock: Arc<dyn ModelConfigurationClock>,
    catalog: Arc<ModelCatalog>,
    collation: Arc<LocaleCollation>,
    registration_catalog: ModelCatalogSnapshot,
    client: Client,
    configuration_writes: Arc<ConfigurationWrites>,
}

/// Raw config and credentials never implement Debug or Serialize. Request
/// consumers borrow the exact selected secret; listing exposes masked views.
pub(crate) struct ModelConfigurationRead {
    pub config: Value,
    pub catalog: ModelCatalogSnapshot,
    pub local: Vec<LocalModelConfig>,
    pub registered: Vec<RegisteredHostedModelConfig>,
    credentials: Vec<CredentialRecord>,
    local_credentials: HashMap<String, String>,
}

pub(crate) struct ModelMetadataRead {
    pub config: Value,
    pub catalog: ModelCatalogSnapshot,
}

impl ModelConfigurationRead {
    pub(crate) fn credential_secret(&self, id: &str, provider: &str) -> Option<&str> {
        self.credentials
            .iter()
            .find(|record| record.id == id && record.provider_id == provider)
            .map(|record| record.secret.as_str())
    }

    pub(crate) fn local_credential_secret(&self, model_ref: &str) -> Option<&str> {
        self.local_credentials.get(model_ref).map(String::as_str)
    }

    #[cfg(test)]
    pub(crate) fn configured_default_model(&self) -> Option<&str> {
        configured_default(&self.config)
    }
}

impl ModelConfiguration {
    /// Context and Turn admission need model facts without credential I/O.
    pub(crate) async fn read_metadata(&self) -> Result<ModelMetadataRead, ModelCatalogError> {
        let config = read_object(&self.data_root.join("butler.config.json")).await;
        let local = self.local_models(&config);
        let catalog = self.catalog.snapshot(
            ModelCatalogSnapshotInput {
                configured_local: local.iter().map(ModelProviderMetadata::from).collect(),
                extra_models: Vec::new(),
                registered_models: Vec::new(),
                credential_views: Vec::new(),
                default_model_ref: None,
                generated_at: self.clock.now_iso(),
            },
            &self.collation,
        )?;
        Ok(ModelMetadataRead { config, catalog })
    }

    pub(crate) fn new(
        data_root: PathBuf,
        environment: ModelConfigurationEnvironment,
        clock: Arc<dyn ModelConfigurationClock>,
        catalog: Arc<ModelCatalog>,
        collation: Arc<LocaleCollation>,
        client: Client,
        configuration_writes: Arc<ConfigurationWrites>,
    ) -> Result<Self, ModelCatalogError> {
        let registration_catalog = catalog.snapshot(
            ModelCatalogSnapshotInput {
                configured_local: Vec::new(),
                extra_models: Vec::new(),
                registered_models: Vec::new(),
                credential_views: Vec::new(),
                default_model_ref: None,
                generated_at: clock.now_iso(),
            },
            &collation,
        )?;
        Ok(Self {
            data_root,
            environment,
            clock,
            catalog,
            collation,
            registration_catalog,
            client,
            configuration_writes,
        })
    }

    pub(crate) async fn read(&self) -> Result<ModelConfigurationRead, ModelCatalogError> {
        self.read_from(&self.data_root).await
    }

    async fn read_from(&self, root: &Path) -> Result<ModelConfigurationRead, ModelCatalogError> {
        let config_path = root.join("butler.config.json");
        let credential_path = root.join("auth/model-provider-credentials.json");
        let local_credential_path = root.join("auth/custom-model-credentials.json");
        let (config, credential_file, local_credentials) = tokio::join!(
            read_object(&config_path),
            read_object(&credential_path),
            local_credentials::read(&local_credential_path),
        );
        let local_credentials = local_credentials?;
        let local = self.local_models(&config);
        let local_metadata: Vec<ModelProviderMetadata> = local.iter().map(Into::into).collect();
        let registered = first_by_key(
            array(config.pointer("/models/registered"))
                .iter()
                .filter_map(|value| {
                    normalize_registered_hosted_model(
                        value,
                        &self.registration_catalog,
                        &self.clock.now_iso(),
                    )
                }),
            |value| value.model_ref.clone(),
        );
        let credentials = credentials::read(
            &credential_file,
            &self.registration_catalog,
            self.clock.as_ref(),
        );
        drop(credential_file);
        let credential_views = credentials
            .iter()
            .map(CredentialRecord::view)
            .collect::<Vec<_>>();
        let probes = probes::read(&config);
        let codex_url =
            self.environment.codex_base_url.as_ref().and_then(|value| {
                normalize_hosted_api_base_url(Some(&Value::String(value.clone())))
            });
        let mut registered_metadata = registered_hosted_model_metadata(
            &registered,
            &self.registration_catalog,
            &credential_views,
            &probes,
            codex_url.as_deref(),
        );
        registered_metadata.extend(local_metadata.iter().cloned());
        let catalog = self.catalog.snapshot(
            ModelCatalogSnapshotInput {
                configured_local: local_metadata.clone(),
                extra_models: local_metadata,
                registered_models: registered_metadata,
                credential_views,
                default_model_ref: app_default(&config).map(str::to_owned),
                generated_at: self.clock.now_iso(),
            },
            &self.collation,
        )?;
        Ok(ModelConfigurationRead {
            config,
            catalog,
            local,
            registered,
            credentials,
            local_credentials,
        })
    }

    fn sizing_catalog(&self, root: &Path) -> Result<ModelCatalogSnapshot, ModelCatalogError> {
        let config = read_object_sync(&root.join("butler.config.json"));
        let local = self.local_models(&config);
        let local_metadata = local.iter().map(Into::into).collect::<Vec<_>>();
        let registered = first_by_key(
            array(config.pointer("/models/registered"))
                .iter()
                .filter_map(|value| {
                    normalize_registered_hosted_model(
                        value,
                        &self.registration_catalog,
                        &self.clock.now_iso(),
                    )
                }),
            |value| value.model_ref.clone(),
        );
        let probes = probes::read(&config);
        let codex_url =
            self.environment.codex_base_url.as_ref().and_then(|value| {
                normalize_hosted_api_base_url(Some(&Value::String(value.clone())))
            });
        let mut registered_metadata = registered_hosted_model_metadata(
            &registered,
            &self.registration_catalog,
            &[],
            &probes,
            codex_url.as_deref(),
        );
        registered_metadata.extend(local_metadata.iter().cloned());
        self.catalog.snapshot(
            ModelCatalogSnapshotInput {
                configured_local: local_metadata.clone(),
                extra_models: local_metadata,
                registered_models: registered_metadata,
                credential_views: Vec::new(),
                default_model_ref: app_default(&config).map(str::to_owned),
                generated_at: self.clock.now_iso(),
            },
            &self.collation,
        )
    }

    fn local_models(&self, config: &Value) -> Vec<LocalModelConfig> {
        let raw = config
            .pointer("/models/local")
            .filter(|value| value.is_array())
            .or_else(|| config.get("localModels"));
        first_by_key(
            array(raw)
                .iter()
                .filter_map(|value| normalize_local_model_config(value, &self.clock.now_iso())),
            |value| value.model_ref.clone(),
        )
    }

    pub(crate) fn openai_authorize_url(
        &self,
        redirect_uri: &str,
        challenge: &str,
        state: &str,
        scope: Option<&str>,
    ) -> Result<url::Url, ModelAuthError> {
        self.auth_owner()
            .authorize_url(redirect_uri, challenge, state, scope)
    }

    pub(crate) async fn exchange_openai_oauth_code(
        &self,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<OpenAiAuthProfile, ModelAuthError> {
        self.auth_owner()
            .exchange_code(code, redirect_uri, verifier)
            .await
    }

    pub(crate) async fn write_openai_auth_profile(
        &self,
        profile: &OpenAiAuthProfile,
    ) -> Result<(), ModelAuthError> {
        self.auth_owner().write_profile_value(profile).await
    }

    /// Resolve the same private OpenAI/Codex auth used by model requests for
    /// provider-owned public web search. Secrets stay inside the Models port.
    pub(crate) async fn resolve_openai_auth_for_web_search(
        &self,
        private_environment: &HashMap<String, String>,
    ) -> Result<crate::models::ProviderAuth, ModelAuthError> {
        let mut environment = self.environment.clone();
        merge_private_auth_environment(&mut environment, private_environment);
        auth::AuthOwner {
            data_root: &self.data_root,
            environment: &environment,
            clock: self.clock.as_ref(),
            client: &self.client,
        }
        .resolve_openai()
        .await
    }

    pub(crate) async fn discover_local_models(
        &self,
        server_url: &str,
        platform: LocalModelPlatform,
        model_ref: Option<&str>,
        api_key: Option<&str>,
        root: Option<&Path>,
    ) -> Result<LocalModelDiscoveryResult, ModelCatalogError> {
        let (_, api_base_url) = discovery::normalize_server(server_url)?;
        let root = root.unwrap_or(&self.data_root);
        let api_key = if let Some(api_key) = api_key {
            Some(api_key.to_owned())
        } else if let Some(model_ref) = model_ref {
            let config = read_object(&root.join("butler.config.json")).await;
            let saved = self
                .local_models(&config)
                .into_iter()
                .find(|model| model.model_ref == model_ref && model.api_base_url == api_base_url);
            if let Some(saved) = saved {
                let mut secrets =
                    local_credentials::read(&root.join("auth/custom-model-credentials.json"))
                        .await?;
                secrets.remove(&saved.model_ref)
            } else {
                None
            }
        } else {
            None
        };
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ModelCatalogError::new("Local model discovery could not start."))?;
        discovery::discover(&client, server_url, platform, api_key.as_deref()).await
    }

    fn auth_owner(&self) -> auth::AuthOwner<'_> {
        auth::AuthOwner {
            data_root: &self.data_root,
            environment: &self.environment,
            clock: self.clock.as_ref(),
            client: &self.client,
        }
    }
}

#[cfg(test)]
mod auth_tests;
#[cfg(test)]
mod mutations_tests;
#[cfg(test)]
mod provider_tests;
#[cfg(test)]
mod tests;
