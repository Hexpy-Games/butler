use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::gateway::{
    AppModelCatalogCommand, AppModelCatalogPort, ApplicationFuture, GatewayApplicationError,
};
use crate::host::ResolvedInstallation;
use crate::models::{
    HostedModelMutation, LocalModelMutation, ModelCatalogError, ModelConfiguration,
    ProviderAuthMethod, ProviderCredentialMutation,
};

use super::NativeAppSettingsFacts;

pub(crate) struct NativeAppModelCatalog {
    configuration: Arc<ModelConfiguration>,
    settings: Arc<NativeAppSettingsFacts>,
    installation: ResolvedInstallation,
    data_root: PathBuf,
}

impl NativeAppModelCatalog {
    pub(crate) fn new(
        configuration: Arc<ModelConfiguration>,
        settings: Arc<NativeAppSettingsFacts>,
        installation: ResolvedInstallation,
        data_root: PathBuf,
    ) -> Self {
        Self {
            configuration,
            settings,
            installation,
            data_root,
        }
    }

    async fn execute_inner(
        &self,
        command: AppModelCatalogCommand,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            AppModelCatalogCommand::Read => {
                self.validate_model_files()?;
                let read = self.read_catalog().await?;
                catalog_value(&read.catalog.view())
            }
            AppModelCatalogCommand::UpsertCredential(value) => {
                self.validate_model_files()?;
                let input: CredentialInput = decode(value)?;
                let credential = self
                    .configuration
                    .upsert_provider_credential(
                        &ProviderCredentialMutation {
                            provider_id: input.provider_id,
                            api_key: input.api_key,
                            label: input.label,
                            credential_id: input.credential_id,
                        },
                        Some(&self.validated_root()?),
                    )
                    .await
                    .map_err(|error| operation_error("provider_credential_save_failed", error))?;
                let catalog = self.refresh_catalog().await?;
                Ok(json!({"credential":credential,"catalog":catalog}))
            }
            AppModelCatalogCommand::RegisterHosted(value) => {
                self.validate_model_files()?;
                let input: HostedInput = decode(value)?;
                let mutation = HostedModelMutation {
                    provider_id: input.provider_id,
                    model_id: input.model_id,
                    auth_type: input.auth_type,
                    credential_id: input.credential_id,
                    api_key: input.api_key,
                    credential_label: input.credential_label,
                    display_name: input.display_name,
                    api_base_url: input.api_base_url,
                    auth_profile: None,
                };
                let registered = self
                    .configuration
                    .register_hosted_model(&mutation, Some(&self.validated_root()?))
                    .await
                    .map_err(|error| operation_error("hosted_model_registration_failed", error))?;
                let catalog = self.refresh_catalog().await?;
                let model = catalog
                    .get("registered_models")
                    .and_then(Value::as_array)
                    .and_then(|models| {
                        models.iter().find(|model| {
                            model.get("model_ref").and_then(Value::as_str)
                                == Some(registered.model_ref.as_str())
                        })
                    })
                    .cloned()
                    .ok_or(GatewayApplicationError::Internal)?;
                Ok(json!({"model":model,"catalog":catalog}))
            }
            AppModelCatalogCommand::DeleteHosted(lookup) => {
                self.validate_model_files()?;
                let removed = self
                    .configuration
                    .delete_hosted_model(&lookup, Some(&self.validated_root()?))
                    .await
                    .map_err(|error| operation_error("hosted_model_delete_failed", error))?;
                let catalog = self.refresh_catalog().await?;
                Ok(json!({"removed_model_ref":removed.model_ref,"catalog":catalog}))
            }
            AppModelCatalogCommand::DiscoverLocal(value) => {
                self.validate_model_files()?;
                let input: LocalDiscoveryInput = decode(value)?;
                let root = self.validated_root()?;
                let result = tokio::select! {
                    result = self.configuration.discover_local_models(
                        &input.server_url,
                        input.platform,
                        input.model_ref.as_deref(),
                        input.api_key.as_deref(),
                        Some(&root),
                    ) => result,
                    () = cancellation.cancelled() => return Err(GatewayApplicationError::Internal),
                }
                .map_err(|error| {
                    operation_error_status("local_model_discovery_failed", 502, error)
                })?;
                let models = result
                    .models
                    .iter()
                    .map(discovered_model)
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(json!({
                    "server_url": result.server_url,
                    "api_base_url": result.api_base_url,
                    "api_type": result.api_type,
                    "platform": result.platform,
                    "models": models,
                }))
            }
            AppModelCatalogCommand::RegisterLocal(value) => {
                self.validate_model_files()?;
                let input: LocalInput = decode(value)?;
                let mutation = local_mutation(input)?;
                let model = self
                    .configuration
                    .upsert_local_model(&mutation, Some(&self.validated_root()?))
                    .await
                    .map_err(|error| operation_error("local_model_registration_failed", error))?;
                let catalog = self.refresh_catalog().await?;
                let summary = catalog_model(&catalog, &model.model_ref)?;
                Ok(json!({"model":summary,"catalog":catalog}))
            }
            AppModelCatalogCommand::UpdateLocal { lookup, input } => {
                self.validate_model_files()?;
                let input: LocalInput = decode(input)?;
                let mutation = local_mutation(input)?;
                let (model, _) = self
                    .configuration
                    .update_local_model(&lookup, &mutation, Some(&self.validated_root()?))
                    .await
                    .map_err(|error| operation_error("local_model_update_failed", error))?;
                let catalog = self.refresh_catalog().await?;
                let summary = catalog_model(&catalog, &model.model_ref)?;
                Ok(json!({"model":summary,"catalog":catalog}))
            }
            AppModelCatalogCommand::DeleteLocal(lookup) => {
                self.validate_model_files()?;
                let removed = self
                    .configuration
                    .delete_local_model(&lookup, Some(&self.validated_root()?))
                    .await
                    .map_err(|error| operation_error("local_model_delete_failed", error))?;
                let catalog = self.refresh_catalog().await?;
                Ok(json!({"removed_model_ref":removed.model_ref,"catalog":catalog}))
            }
        }
    }

    fn validated_root(&self) -> Result<PathBuf, GatewayApplicationError> {
        let root = self
            .installation
            .validate_data_root(&self.data_root)
            .map_err(|_| unsafe_model_path())?;
        for relative in [
            "butler.config.json",
            "auth",
            "auth/model-provider-credentials.json",
            "auth/custom-model-credentials.json",
        ] {
            let target = self
                .installation
                .validate_data_root(&self.data_root.join(relative))
                .map_err(|_| unsafe_model_path())?;
            if !target.starts_with(&root) {
                return Err(unsafe_model_path());
            }
        }
        Ok(root)
    }

    fn validate_model_files(&self) -> Result<(), GatewayApplicationError> {
        self.validated_root().map(|_| ())
    }

    async fn read_catalog(
        &self,
    ) -> Result<crate::models::ModelConfigurationRead, GatewayApplicationError> {
        self.configuration
            .read()
            .await
            .map_err(|_| GatewayApplicationError::Internal)
    }

    async fn refresh_catalog(&self) -> Result<Value, GatewayApplicationError> {
        self.settings.refresh().await?;
        let read = self.read_catalog().await?;
        catalog_value(&read.catalog.view())
    }
}

impl AppModelCatalogPort for NativeAppModelCatalog {
    fn execute(
        &self,
        command: AppModelCatalogCommand,
        cancellation: CancellationToken,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_for_future();
        Box::pin(async move { this.execute_inner(command, cancellation).await })
    }
}

impl NativeAppModelCatalog {
    fn clone_for_future(&self) -> Self {
        Self {
            configuration: self.configuration.clone(),
            settings: self.settings.clone(),
            installation: self.installation.clone(),
            data_root: self.data_root.clone(),
        }
    }
}

#[derive(Deserialize)]
struct CredentialInput {
    provider_id: String,
    api_key: String,
    label: Option<String>,
    credential_id: Option<String>,
}

#[derive(Deserialize)]
struct HostedInput {
    provider_id: String,
    model_id: String,
    display_name: Option<String>,
    auth_type: ProviderAuthMethod,
    credential_id: Option<String>,
    api_key: Option<String>,
    credential_label: Option<String>,
    api_base_url: Option<String>,
}

#[derive(Deserialize)]
struct LocalDiscoveryInput {
    model_ref: Option<String>,
    api_key: Option<String>,
    server_url: String,
    platform: crate::models::LocalModelPlatform,
}

#[derive(Deserialize)]
struct LocalInput {
    api_key: Option<String>,
    server_url: String,
    platform: crate::models::LocalModelPlatform,
    model_id: String,
    display_name: Option<String>,
    context_window_tokens: f64,
    max_output_tokens: Option<f64>,
    reasoning_budget_ratio: Option<f64>,
    source: Option<crate::models::LocalModelSource>,
}

fn local_mutation(input: LocalInput) -> Result<LocalModelMutation, GatewayApplicationError> {
    Ok(LocalModelMutation {
        server_url: input.server_url,
        api_key: input.api_key,
        platform: input.platform,
        model_id: input.model_id,
        display_name: input.display_name,
        context_window_tokens: input.context_window_tokens,
        max_output_tokens: input.max_output_tokens,
        reasoning_budget_ratio: input.reasoning_budget_ratio,
        source: input
            .source
            .unwrap_or(crate::models::LocalModelSource::Discovered),
    })
}

fn discovered_model(
    model: &crate::models::DiscoveredLocalModel,
) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(crate::models::ModelProviderMetadata::from(model))
        .map_err(|_| GatewayApplicationError::Internal)
}

fn catalog_model(catalog: &Value, model_ref: &str) -> Result<Value, GatewayApplicationError> {
    catalog
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| {
            models
                .iter()
                .find(|model| model.get("model_ref").and_then(Value::as_str) == Some(model_ref))
        })
        .cloned()
        .ok_or(GatewayApplicationError::Internal)
}

fn catalog_value<T: serde::Serialize>(catalog: &T) -> Result<Value, GatewayApplicationError> {
    serde_json::to_value(catalog).map_err(|_| GatewayApplicationError::Internal)
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, GatewayApplicationError> {
    serde_json::from_value(value).map_err(|_| invalid_model_input())
}

fn invalid_model_input() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_model_catalog_request".into(),
        message: "Model catalog request is invalid.".into(),
    }
}

fn operation_error(code: &str, error: ModelCatalogError) -> GatewayApplicationError {
    operation_error_status(code, 400, error)
}

fn operation_error_status(
    code: &str,
    status: u16,
    error: ModelCatalogError,
) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: error.to_string(),
    }
}

fn unsafe_model_path() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "unsafe_configuration_path".into(),
        message: "Model configuration is outside the selected DATA directory.".into(),
    }
}
