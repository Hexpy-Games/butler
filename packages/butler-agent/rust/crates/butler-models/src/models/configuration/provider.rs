//! Physical provider request snapshots resolved from current filesystem state.

mod auth;
mod dynamic;
mod endpoint;
mod policy;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use super::{
    ModelConfiguration, ModelConfigurationRead,
    auth::{AuthError, AuthOwner},
};
use crate::models::{
    ModelCatalogSnapshot, PromptCacheRetention, ProviderAuth, ProviderAuthMethod,
    ProviderConfigFuture, ProviderConfigRequest, ProviderPromptCachePolicy, ProviderRequestConfig,
    ProviderRequestConfigPort, ProviderRoundPolicy, RegisteredHostedModelConfig, parse_model_ref,
};
use butler_turn::btcc::{BtccError, ModelRoundError, ProviderRequestError};

impl ProviderRequestConfigPort for ModelConfiguration {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        let config = super::read_object_sync(&self.data_root.join("butler.config.json"));
        let model = requested
            .map(butler_core::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| super::configured_default(&config).map(str::to_owned))
            .unwrap_or_else(|| self.default_model_from(&self.data_root).model);
        let provider = parse_model_ref(&model).provider_id;
        if [
            "openai",
            "anthropic",
            "google",
            "xai",
            "qwen",
            "kimi",
            "zai",
            "zai-api",
            "opencode-go",
            "local",
        ]
        .contains(&provider.as_str())
        {
            return Ok(model);
        }
        Err(ModelRoundError::InvocationFailure {
            code: Some(format!("provider_adapter_not_registered:{provider}")),
            message: format!("Provider adapter is not registered: {provider}."),
        })
    }

    fn resolve<'a>(&'a self, request: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(self.resolve_request(request))
    }

    fn sizing_snapshot(
        &self,
        butler_data: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        let root = self.selected_root(butler_data);
        self.sizing_catalog(&root).map(Arc::new).map_err(|error| {
            ModelRoundError::Integrity(BtccError::relayed(
                "model_configuration_read_failed",
                error.to_string(),
            ))
        })
    }
}

impl ModelConfiguration {
    #[tracing::instrument(name = "route.resolve", level = "debug", skip_all, fields(model = %request.model_ref, chosen = tracing::field::Empty, key_source = tracing::field::Empty), err)]
    async fn resolve_request(
        &self,
        request: ProviderConfigRequest<'_>,
    ) -> Result<ProviderRequestConfig, Box<ProviderRequestError>> {
        let root = self.selected_root(request.butler_data);
        let read = self.read_from(&root).await.map_err(|_| {
            provider_error(
                "configuration_read_failed",
                "configuration",
                "Model configuration could not be read.",
            )
        })?;
        let requested = effective_model(request.model_ref, &read, &self.environment);
        let parsed = parse_model_ref(&requested);
        let metadata = read
            .catalog
            .view()
            .registered_models
            .iter()
            .find(|candidate| {
                candidate.provider_id != "local"
                    && (candidate.model_ref == requested || candidate.model_id == requested)
            })
            .cloned()
            .or_else(|| read.catalog.find_model_metadata(Some(&requested)))
            .unwrap_or_else(|| read.catalog.resolve_model_metadata(Some(&requested)));
        if (!metadata.runtime_supported && metadata.provider_id != "openai")
            || metadata.provider_id != parsed.provider_id
        {
            return Err(provider_error_for(
                &parsed.provider_id,
                "provider_model_unavailable",
                "configuration",
                "Configured model is unavailable.",
            ));
        }
        let registered = registered_config(&read, &parsed.provider_id, &metadata.model_ref);
        if metadata.provider_id != "openai"
            && metadata.provider_id != "local"
            && registered.is_none()
        {
            return Err(provider_error_for(
                &metadata.provider_id,
                "provider_configuration_missing",
                "configuration",
                "Hosted model is not registered.",
            ));
        }
        let auth = self
            .resolve_auth(
                &root,
                &read,
                &metadata.provider_id,
                &metadata.model_ref,
                registered.as_ref(),
                request.rejected_authorization,
            )
            .await?;
        let local_base = read
            .local
            .iter()
            .find(|value| value.model_ref == metadata.model_ref)
            .map(|value| value.api_base_url.as_str());
        let endpoint = endpoint::resolve(
            self,
            &metadata.provider_id,
            &metadata.model_id,
            metadata.hosted_api_shape,
            registered.as_ref(),
            local_base,
            auth.mode(),
        )?;
        let policy = self.round_policy(&read, &metadata);
        let prompt_cache = if metadata.provider_id == "openai" {
            self.prompt_cache(&read, &root)
        } else {
            ProviderPromptCachePolicy::default()
        };
        let prompt_reasoning_effort = (metadata.provider_id == "openai")
            .then(|| dynamic::configured_reasoning(&self.environment, &read.config));
        let wire_model = endpoint::wire_model(&metadata, &parsed, auth.mode());
        Ok(record_route(ProviderRequestConfig {
            wire_model,
            api_shape: metadata.hosted_api_shape,
            metadata,
            endpoint,
            auth,
            policy,
            retry_attempts: super::admission::retry_attempts(
                self.environment.retry_attempts.as_deref(),
            ),
            prompt_cache,
            prompt_reasoning_effort,
        }))
    }

    fn selected_root(&self, butler_data: Option<&str>) -> PathBuf {
        butler_data
            .map(butler_core::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_root.clone())
    }

    /// A Custom model's own response time limit replaces the global total.
    fn round_policy(
        &self,
        read: &ModelConfigurationRead,
        metadata: &crate::models::ModelProviderMetadata,
    ) -> ProviderRoundPolicy {
        let total = read
            .local
            .iter()
            .find(|model| model.model_ref == metadata.model_ref)
            .and_then(|model| model.response_timeout_ms)
            .map(std::time::Duration::from_millis)
            .unwrap_or_else(|| {
                policy::total(self.environment.provider_round_timeout_ms.as_deref())
            });
        let idle = (metadata.provider_id != "openai")
            .then(|| policy::idle(self.environment.provider_round_idle_timeout_ms.as_deref()));
        ProviderRoundPolicy {
            total,
            idle,
            retry_base_ms: policy::retry_base(
                self.environment.provider_retry_base_delay_ms.as_deref(),
            ),
        }
    }

    fn prompt_cache(
        &self,
        read: &ModelConfigurationRead,
        root: &Path,
    ) -> ProviderPromptCachePolicy {
        self.prompt_cache_from_config(&read.config, root)
    }

    fn prompt_cache_from_config(
        &self,
        config: &serde_json::Value,
        root: &Path,
    ) -> ProviderPromptCachePolicy {
        let configured = self
            .environment
            .openai_prompt_cache_key_prefix
            .as_deref()
            .map(policy::sanitize_cache_segment)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config
                    .pointer("/system/openaiPromptCacheKeyPrefix")
                    .and_then(serde_json::Value::as_str)
                    .map(policy::sanitize_cache_segment)
                    .filter(|value| !value.is_empty())
            });
        let key_prefix = if configured.is_some() {
            configured
        } else {
            Some(policy::cache_prefix(root))
        };
        let retention = self
            .environment
            .openai_prompt_cache_retention
            .as_deref()
            .and_then(policy::cache_retention)
            .or_else(|| {
                config
                    .pointer("/system/openaiPromptCacheRetention")
                    .and_then(serde_json::Value::as_str)
                    .and_then(policy::cache_retention)
            })
            .or(Some(PromptCacheRetention::Hours24));
        ProviderPromptCachePolicy {
            key_prefix,
            retention,
        }
    }
}

fn effective_model(
    requested: &str,
    read: &ModelConfigurationRead,
    environment: &crate::models::ModelConfigurationEnvironment,
) -> String {
    let requested = butler_core::public_text::trim_js_whitespace(requested);
    if requested.is_empty() {
        dynamic::configured_model(environment, &read.config)
            .unwrap_or_else(|| read.catalog.view().default_model_ref.clone())
    } else {
        requested.into()
    }
}

fn registered_config(
    read: &ModelConfigurationRead,
    provider: &str,
    model_ref: &str,
) -> Option<RegisteredHostedModelConfig> {
    let parsed = parse_model_ref(model_ref);
    read.registered
        .iter()
        .find(|value| {
            value.provider_id == provider
                && (value.model_ref == parsed.canonical_ref || value.model_id == parsed.model_id)
        })
        .or_else(|| {
            read.default_connection
                .as_ref()
                .filter(|value| value.model_ref == parsed.canonical_ref)
        })
        .cloned()
        .or_else(|| {
            let preset = read.catalog.search_planning_preset(provider)?;
            if preset.model != parsed.canonical_ref {
                return None;
            }
            let connection = read
                .registered
                .iter()
                .find(|entry| {
                    entry.provider_id == provider
                        && entry.model_ref == read.catalog.view().default_model_ref
                })
                .or_else(|| {
                    read.default_connection
                        .as_ref()
                        .filter(|entry| entry.provider_id == provider)
                })?;
            let mut planning = connection.clone();
            planning.model_ref = parsed.canonical_ref;
            planning.model_id = parsed.model_id;
            Some(planning)
        })
}
#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn auth_error(error: AuthError) -> Box<ProviderRequestError> {
    let mut result = provider_error(error.code, "authentication", error.message);
    result.cause = error.reason.map(str::to_owned);
    result.retryable = error.code == "provider_auth_refresh_unavailable";
    result
}
fn provider_error(code: &str, api: &str, message: &str) -> Box<ProviderRequestError> {
    provider_error_for("openai", code, api, message)
}
fn provider_error_for(
    provider: &str,
    code: &str,
    api: &str,
    message: &str,
) -> Box<ProviderRequestError> {
    Box::new(ProviderRequestError {
        auth_type: None,
        code: code.into(),
        message: message.into(),
        provider: provider.into(),
        api: api.into(),
        status_code: None,
        endpoint: None,
        model: None,
        retryable: false,
        cause: None,
        request_generation: None,
        measured_input_tokens: None,
        registered_input_capacity: None,
        request_hash: None,
        timeout_kind: None,
        retry_at: None,
        provider_request_id: None,
        rate_limit: None,
        provider_error_code: None,
        provider_error_type: None,
        provider_error_details: None,
    })
}

impl ModelConfiguration {
    /// Reads the cache policy without resolving auth or preparing a request.
    pub(crate) fn status_prompt_cache_policy(&self) -> ProviderPromptCachePolicy {
        let config = super::read_object_sync(&self.data_root.join("butler.config.json"));
        self.prompt_cache_from_config(&config, &self.data_root)
    }
}

fn record_route(config: ProviderRequestConfig) -> ProviderRequestConfig {
    tracing::Span::current()
        .record("chosen", &config.metadata.model_ref)
        .record(
            "key_source",
            match &config.auth {
                ProviderAuth::ApiKey(_) => "credential_store",
                ProviderAuth::ChatGptPlan { .. } => "oauth_profile",
                ProviderAuth::None => "none",
            },
        );
    config
}
