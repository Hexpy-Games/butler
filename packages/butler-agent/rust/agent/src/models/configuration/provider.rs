//! Physical provider request snapshots resolved from current filesystem state.

#[path = "provider/status.rs"]
mod status;

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
use crate::{
    btcc::{BtccError, ModelRoundError, ProviderRequestError},
    models::{
        ModelCatalogSnapshot, PromptCacheRetention, ProviderAuth, ProviderAuthMethod,
        ProviderConfigFuture, ProviderConfigRequest, ProviderPromptCachePolicy,
        ProviderRequestConfig, ProviderRequestConfigPort, ProviderRoundPolicy,
        RegisteredHostedModelConfig, parse_model_ref,
    },
};

const DEFAULT_MODEL_REF: &str = "openai/gpt-5.5-codex";

impl ProviderRequestConfigPort for ModelConfiguration {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        let config = super::read_object_sync(&self.data_root.join("butler.config.json"));
        let model = requested
            .map(crate::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| super::configured_default(&config).map(str::to_owned))
            .unwrap_or_else(|| DEFAULT_MODEL_REF.to_owned());
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
        Box::pin(async move { self.resolve_request(request).await.map_err(Box::new) })
    }

    fn sizing_snapshot(
        &self,
        butler_data: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        let root = self.selected_root(butler_data);
        self.sizing_catalog(&root).map(Arc::new).map_err(|error| {
            ModelRoundError::Integrity(BtccError::new(
                "model_configuration_read_failed",
                error.to_string(),
            ))
        })
    }
}

impl ModelConfiguration {
    async fn resolve_request(
        &self,
        request: ProviderConfigRequest<'_>,
    ) -> Result<ProviderRequestConfig, ProviderRequestError> {
        let root = self.selected_root(request.butler_data);
        let read = self.read_from(&root).await.map_err(|_| {
            provider_error(
                "configuration_read_failed",
                "configuration",
                "Model configuration could not be read.",
            )
        })?;
        let configured_openai_request =
            crate::public_text::trim_js_whitespace(request.model_ref).is_empty();
        let requested = effective_model(request.model_ref, &read, &self.environment);
        let requested_model = parse_model_ref(&requested);
        let requested = if (configured_openai_request && requested == dynamic::AUTO_CODEX_LATEST)
            || (!configured_openai_request
                && requested_model.provider_id == "openai"
                && requested_model.model_id == dynamic::AUTO_CODEX_LATEST)
        {
            dynamic::resolve(self, &root, &read).await?
        } else {
            requested
        };
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
                registered,
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
            registered,
            local_base,
            auth.mode(),
        )
        .map_err(|failure| *failure)?;
        let policy = self.round_policy(&metadata.provider_id);
        let prompt_cache = if metadata.provider_id == "openai" {
            self.prompt_cache(&read, &root)
        } else {
            ProviderPromptCachePolicy::default()
        };
        let prompt_reasoning_effort = (metadata.provider_id == "openai")
            .then(|| dynamic::configured_reasoning(&self.environment, &read.config));
        let wire_model = if metadata.provider_id == "openai" {
            if configured_openai_request {
                requested.clone()
            } else {
                parsed.model_id.clone()
            }
        } else {
            metadata.model_id.clone()
        };
        Ok(ProviderRequestConfig {
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
        })
    }

    fn selected_root(&self, butler_data: Option<&str>) -> PathBuf {
        butler_data
            .map(crate::public_text::trim_js_whitespace)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_root.clone())
    }

    async fn resolve_auth(
        &self,
        root: &Path,
        read: &ModelConfigurationRead,
        provider: &str,
        model_ref: &str,
        registered: Option<&RegisteredHostedModelConfig>,
    ) -> Result<ProviderAuth, ProviderRequestError> {
        if let Some(config) = registered {
            if config.auth_type == ProviderAuthMethod::ApiKey {
                let secret = config
                    .credential_id
                    .as_deref()
                    .and_then(|id| read.credential_secret(id, &config.provider_id))
                    .ok_or_else(|| {
                        provider_error_for(
                            &config.provider_id,
                            "provider_auth_missing",
                            "configuration",
                            "Provider API key credential is not registered.",
                        )
                    })?;
                return Ok(ProviderAuth::ApiKey(secret.to_owned()));
            }
            if config.provider_id != "openai" {
                return Err(provider_error_for(
                    &config.provider_id,
                    "provider_auth_unsupported",
                    "configuration",
                    "Configured provider authentication is unsupported.",
                ));
            }
        }
        if provider == "local" {
            return Ok(read
                .local_credential_secret(model_ref)
                .map(|secret| ProviderAuth::ApiKey(secret.to_owned()))
                .unwrap_or(ProviderAuth::None));
        }
        if provider != "openai" {
            return Err(provider_error_for(
                provider,
                "provider_auth_missing",
                "configuration",
                "Provider API key credential is not registered.",
            ));
        }
        let private_environment =
            crate::configuration::read_private_environment(&root.join(".env")).unwrap_or_default();
        let mut environment = self.environment.clone();
        super::merge_private_auth_environment(&mut environment, &private_environment);
        let owner = AuthOwner {
            data_root: root,
            environment: &environment,
            clock: self.clock.as_ref(),
            client: &self.client,
        };
        if registered.is_some_and(|value| value.auth_type == ProviderAuthMethod::CodexOauth) {
            owner.resolve_codex().await.map_err(auth_error)
        } else {
            owner.resolve_openai().await.map_err(auth_error)
        }
    }

    fn round_policy(&self, provider: &str) -> ProviderRoundPolicy {
        let total = policy::total(self.environment.provider_round_timeout_ms.as_deref());
        let idle = (provider != "openai")
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
    let requested = crate::public_text::trim_js_whitespace(requested);
    if !requested.is_empty() {
        requested.into()
    } else {
        dynamic::configured_model(environment, &read.config)
    }
}

fn registered_config<'a>(
    read: &'a ModelConfigurationRead,
    provider: &str,
    model_ref: &str,
) -> Option<&'a RegisteredHostedModelConfig> {
    let parsed = parse_model_ref(model_ref);
    read.registered.iter().find(|value| {
        value.provider_id == provider
            && (value.model_ref == parsed.canonical_ref || value.model_id == parsed.model_id)
    })
}
fn auth_error(error: AuthError) -> ProviderRequestError {
    provider_error(error.code, "authentication", error.message)
}
fn provider_error(code: &str, api: &str, message: &str) -> ProviderRequestError {
    provider_error_for("openai", code, api, message)
}
fn provider_error_for(
    provider: &str,
    code: &str,
    api: &str,
    message: &str,
) -> ProviderRequestError {
    ProviderRequestError {
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
    }
}
