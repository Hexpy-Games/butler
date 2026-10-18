//! Request-local registered-credential selection.
use super::*;
impl ModelConfiguration {
    pub(super) async fn resolve_selected_auth(
        &self,
        root: &Path,
        read: &ModelConfigurationRead,
        metadata: &crate::models::ModelProviderMetadata,
        registered: Option<&RegisteredHostedModelConfig>,
        dynamic_auth: Option<ProviderAuth>,
        rejected: Option<&str>,
    ) -> Result<ProviderAuth, Box<ProviderRequestError>> {
        if let Some(auth @ ProviderAuth::ChatGptPlan { .. }) = dynamic_auth
            && registered.is_none_or(|r| r.auth_type == ProviderAuthMethod::ChatGptOauth)
        {
            return Ok(auth);
        }
        self.resolve_auth(
            root,
            read,
            &metadata.provider_id,
            &metadata.model_ref,
            registered,
            rejected,
        )
        .await
    }
    pub(super) async fn resolve_auth(
        &self,
        root: &Path,
        read: &ModelConfigurationRead,
        provider: &str,
        model_ref: &str,
        registered: Option<&RegisteredHostedModelConfig>,
        rejected: Option<&str>,
    ) -> Result<ProviderAuth, Box<ProviderRequestError>> {
        if let Some(config) = registered {
            if config.auth_type == ProviderAuthMethod::ApiKey {
                return self.registered_api_key(root, read, config).await;
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
                .map(|secret| ProviderAuth::ApiKey(zeroize::Zeroizing::new(secret.to_owned())))
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
        let environment_path = root.join(".env");
        let private_environment = tokio::task::spawn_blocking(move || {
            butler_core::configuration::read_private_environment(&environment_path)
                .unwrap_or_default()
        })
        .await
        .map_err(|_| {
            provider_error(
                "configuration_read_failed",
                "configuration",
                "Private configuration could not be read.",
            )
        })?;
        let mut environment = self.environment.clone();
        super::super::merge_private_auth_environment(&mut environment, &private_environment);
        let owner = AuthOwner {
            data_root: root,
            environment: &environment,
            clock: &self.clock,
            client: &self.client,
            revision: &self.account_revision,
        };
        if registered.is_some_and(|value| value.auth_type == ProviderAuthMethod::ChatGptOauth) {
            owner.resolve_chatgpt(rejected).await.map_err(auth_error)
        } else {
            owner
                .resolve_openai_after(rejected)
                .await
                .map_err(auth_error)
        }
    }
    async fn registered_api_key(
        &self,
        root: &Path,
        read: &ModelConfigurationRead,
        config: &RegisteredHostedModelConfig,
    ) -> Result<ProviderAuth, Box<ProviderRequestError>> {
        let record = config
            .credential_id
            .as_deref()
            .and_then(|id| read.credential(id, &config.provider_id))
            .ok_or_else(|| {
                provider_error_for(
                    &config.provider_id,
                    "provider_auth_missing",
                    "configuration",
                    "Provider API key credential is not registered.",
                )
            })?;
        // Read from its store for this request only; never cached.
        let secret = self
            .credential_secret(root, record)
            .await
            .map_err(|error| {
                provider_error_for(
                    &config.provider_id,
                    error.code(),
                    "configuration",
                    "The saved API key could not be read from the credential store.",
                )
            })?;
        Ok(ProviderAuth::ApiKey(secret.into_zeroizing()))
    }
}
