//! First-run setup for the App (#230): the agent's background preparation,
//! local model servers, API keys and the ChatGPT sign-in flow, behind the
//! gateway's [`AppSetupPort`].

mod credentials;
mod oauth;
mod readiness;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use butler_gateway::gateway::{
    AppCredentialReplaceInput, AppOauthStartInput, AppProviderKeyInput, AppSetupPort,
    ApplicationFuture, GatewayApplicationError, LocalModelServersView, OauthFlowView,
    ProviderKeyVerificationView, ReplacedCredentialView, SavedCredentialView, SetupReadinessView,
};
use butler_models::models::{
    CredentialList, DeletedCredential, LocalServerKind, LocalServerProbe, ModelConfiguration,
    detect_local_servers,
};
use butler_runtime::operations::ServiceReadiness;

use crate::host::{AppSettingsFactsAdapter, ResolvedInstallation};
use oauth::OauthFlows;
use readiness::{Preparation, ReadinessChecks};

/// How long one local server may take to answer.
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Everything first-run setup needs from the process.
pub(crate) struct AppSetupParts {
    pub(crate) configuration: Arc<ModelConfiguration>,
    pub(crate) settings: Arc<AppSettingsFactsAdapter>,
    pub(crate) installation: ResolvedInstallation,
    pub(crate) data_root: PathBuf,
    pub(crate) executor: Arc<ServiceReadiness>,
}

/// Cheap to clone: every clone shares one preparation and one flow table.
#[derive(Clone)]
pub(crate) struct AppSetup(Arc<SetupInner>);

struct SetupInner {
    configuration: Arc<ModelConfiguration>,
    settings: Arc<AppSettingsFactsAdapter>,
    installation: ResolvedInstallation,
    data_root: PathBuf,
    preparation: Preparation,
    oauth: OauthFlows,
    local_servers: Vec<LocalServerProbe>,
}

impl AppSetup {
    /// Starts the background preparation. Local server addresses come from
    /// `BUTLER_OLLAMA_BASE_URL` and `BUTLER_LM_STUDIO_BASE_URL`, else the
    /// servers' default ports on 127.0.0.1.
    pub(crate) fn start(parts: AppSetupParts) -> Self {
        let preparation = Preparation::start(ReadinessChecks {
            data_root: parts.data_root.clone(),
            configuration: parts.configuration.clone(),
            executor: parts.executor,
        });
        Self(Arc::new(SetupInner {
            oauth: OauthFlows::new(parts.configuration.clone()),
            configuration: parts.configuration,
            settings: parts.settings,
            installation: parts.installation,
            data_root: parts.data_root,
            preparation,
            local_servers: local_server_probes(),
        }))
    }

    /// Stops the preparation and every open sign-in (closing its listener).
    pub(crate) async fn close(&self) {
        self.0.preparation.close().await;
        self.0.oauth.cancel_open().await;
    }
}

fn local_server_probes() -> Vec<LocalServerProbe> {
    LocalServerKind::ALL
        .into_iter()
        .map(|kind| {
            let variable = match kind {
                LocalServerKind::Ollama => "BUTLER_OLLAMA_BASE_URL",
                LocalServerKind::LmStudio => "BUTLER_LM_STUDIO_BASE_URL",
            };
            let base_url = std::env::var(variable)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| kind.default_base_url().to_owned());
            LocalServerProbe { kind, base_url }
        })
        .collect()
}

impl AppSetupPort for AppSetup {
    fn readiness(&self) -> watch::Receiver<SetupReadinessView> {
        self.0.preparation.subscribe()
    }

    fn retry_readiness(&self) -> SetupReadinessView {
        self.0.preparation.retry()
    }

    fn local_model_servers(&self) -> ApplicationFuture<LocalModelServersView> {
        let this = self.0.clone();
        Box::pin(async move {
            Ok(LocalModelServersView {
                servers: detect_local_servers(&this.local_servers, LOCAL_PROBE_TIMEOUT).await,
            })
        })
    }

    fn verify_provider_key(
        &self,
        input: AppProviderKeyInput,
    ) -> ApplicationFuture<ProviderKeyVerificationView> {
        let this = self.0.clone();
        Box::pin(async move { credentials::verify(&this.configuration, &input).await })
    }

    fn save_provider_key(
        &self,
        input: AppProviderKeyInput,
    ) -> ApplicationFuture<SavedCredentialView> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            let saved = credentials::save(&this.configuration, &input, &root).await?;
            this.settings.refresh().await?;
            Ok(saved)
        })
    }

    fn list_credentials(&self) -> ApplicationFuture<CredentialList> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            credentials::list(&this.configuration, &root).await
        })
    }

    fn replace_credential(
        &self,
        name: String,
        input: AppCredentialReplaceInput,
    ) -> ApplicationFuture<ReplacedCredentialView> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            let replaced = credentials::replace(&this.configuration, &name, &input, &root).await?;
            this.settings.refresh().await?;
            Ok(replaced)
        })
    }

    fn delete_credential(&self, name: String, force: bool) -> ApplicationFuture<DeletedCredential> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            let deleted = credentials::delete(&this.configuration, &name, force, &root).await?;
            this.settings.refresh().await?;
            Ok(deleted)
        })
    }

    fn start_oauth(&self, input: AppOauthStartInput) -> ApplicationFuture<OauthFlowView> {
        let this = self.0.clone();
        Box::pin(async move { Ok(this.oauth.start(input.force).await) })
    }

    fn oauth_flow(&self, flow_id: String) -> ApplicationFuture<OauthFlowView> {
        let this = self.0.clone();
        Box::pin(async move { this.oauth.view(&flow_id) })
    }

    fn cancel_oauth(&self, flow_id: String) -> ApplicationFuture<OauthFlowView> {
        let this = self.0.clone();
        Box::pin(async move { this.oauth.cancel(&flow_id).await })
    }
}

impl SetupInner {
    /// The data root, checked to be the selected DATA directory, with the
    /// files a key change writes inside it.
    fn validated_root(&self) -> Result<PathBuf, GatewayApplicationError> {
        let root = self
            .installation
            .validate_data_root(&self.data_root)
            .map_err(|source| unsafe_model_path().with_source(source))?;
        for relative in [
            "butler.config.json",
            "auth",
            "auth/model-provider-credentials.json",
            "auth/credential-store.json",
        ] {
            let target = self
                .installation
                .validate_data_root(&self.data_root.join(relative))
                .map_err(|source| unsafe_model_path().with_source(source))?;
            if !target.starts_with(&root) {
                return Err(unsafe_model_path());
            }
        }
        Ok(root)
    }
}

fn unsafe_model_path() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "unsafe_configuration_path".into(),
        message: "Model configuration is outside the selected DATA directory.".into(),
        source: None,
    }
}
