//! First-run setup for the App (#230): the agent's background preparation,
//! local model servers, API keys and the ChatGPT sign-in flow, behind the
//! gateway's [`AppSetupPort`].

mod butler_account;
mod push_relay;
pub(crate) use butler_account::ButlerAccount;
mod butler_vault;
mod chatgpt_account;
mod computer_memory;
mod publishing;
pub(crate) use computer_memory::ComputerMemory;
mod credentials;
mod oauth;
mod readiness;

use butler_platform::secrets::SecretText;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use butler_gateway::gateway::{
    AppCredentialReplaceInput, AppOauthStartInput, AppProviderKeyInput, AppSetupPort,
    ApplicationFuture, ButlerAccountRequest, GatewayApplicationError, LocalModelServersView,
    OauthFlowView, ProviderKeyVerificationView, PublishingRequest, ReplacedCredentialView,
    SavedCredentialView, SavedProviderKey, SetupReadinessView, butler_account_disabled,
};
use butler_models::models::{
    ComputerModel, CredentialList, DeletedCredential, LocalServerKind, LocalServerProbe,
    ModelConfiguration, detect_local_servers,
};
use butler_runtime::operations::ServiceReadiness;

use crate::host::{AppSettingsFactsAdapter, ResolvedInstallation};
use oauth::OauthFlows;
use readiness::{Preparation, ReadinessChecks};

/// How long one local server may take to answer.
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Everything first-run setup needs from the process.
pub(crate) struct AppSetupParts {
    pub(crate) butler_account: Option<Arc<ButlerAccount>>,
    pub(crate) butler_backup: Option<crate::host::backup::BackupService>,
    pub(crate) computer_memory: Arc<ComputerMemory>,
    pub(crate) plugins: Arc<crate::host::plugins::Plugins>,
    pub(crate) configuration: Arc<ModelConfiguration>,
    pub(crate) settings: Arc<AppSettingsFactsAdapter>,
    pub(crate) installation: ResolvedInstallation,
    pub(crate) data_root: PathBuf,
    pub(crate) executor: Arc<ServiceReadiness>,
    pub(crate) acquisition: Arc<crate::host::embedding::worker::assets::Acquisition>,
}

/// Cheap to clone: every clone shares one preparation and one flow table.
#[derive(Clone)]
pub(crate) struct AppSetup(Arc<SetupInner>);

struct SetupInner {
    computer_memory: Arc<ComputerMemory>,
    butler_account: Option<Arc<ButlerAccount>>,
    butler_backup: Option<crate::host::backup::BackupService>,
    plugins: Arc<crate::host::plugins::Plugins>,
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
        let preparation = Preparation::start(
            ReadinessChecks {
                data_root: parts.data_root.clone(),
                configuration: parts.configuration.clone(),
                executor: parts.executor,
            },
            parts.acquisition,
        );
        Self(Arc::new(SetupInner {
            butler_account: parts.butler_account,
            butler_backup: parts.butler_backup,
            computer_memory: parts.computer_memory,
            oauth: OauthFlows::new(parts.configuration.clone()),
            configuration: parts.configuration,
            plugins: parts.plugins,
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
    fn butler_backup(
        &self,
        request: butler_gateway::gateway::ButlerBackupRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        let this = self.0.clone();
        Box::pin(async move {
            match &this.butler_backup {
                Some(backup) => backup.handle(request).await,
                None => Err(butler_account_disabled()),
            }
        })
    }

    fn butler_account(
        &self,
        request: ButlerAccountRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        let this = self.0.clone();
        Box::pin(async move {
            match &this.butler_account {
                Some(account) => account.handle(request).await,
                None => Err(butler_account_disabled()),
            }
        })
    }

    fn publishing(&self, request: PublishingRequest) -> ApplicationFuture<serde_json::Value> {
        let this = self.0.clone();
        Box::pin(async move {
            match &this.butler_account {
                Some(account) => account.publishing(request).await,
                None => Err(butler_account_disabled()),
            }
        })
    }

    fn readiness(&self) -> watch::Receiver<SetupReadinessView> {
        self.0.preparation.subscribe()
    }

    fn retry_readiness(&self) -> SetupReadinessView {
        self.0.preparation.retry()
    }

    fn retry_memory_model(&self) -> SetupReadinessView {
        self.0.preparation.retry_memory_model()
    }

    fn choose_memory_model(&self, enabled: bool) -> ApplicationFuture<SetupReadinessView> {
        let this = self.0.clone();
        Box::pin(async move {
            this.preparation
                .choose_memory_model(enabled)
                .await
                .map_err(|code| GatewayApplicationError::Public {
                    status: 409,
                    code: code.into(),
                    message: "The memory model choice could not be saved.".into(),
                    source: None,
                })
        })
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

    fn saved_provider_key(&self, name: String) -> ApplicationFuture<SavedProviderKey> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            credentials::saved_key(&this.configuration, &name, &root).await
        })
    }

    fn computer_model(&self, credential_id: Option<String>) -> ApplicationFuture<ComputerModel> {
        let this = self.0.clone();
        let configuration = this.configuration.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let root = this.validated_root()?;
                credentials::computer_model(&configuration, credential_id.as_deref(), &root)
            })
            .await
            .map_err(|_| GatewayApplicationError::internal())?
        })
    }

    fn computer_key(&self, id: String) -> ApplicationFuture<SecretText> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            credentials::computer_key(&this.configuration, &id, &root).await
        })
    }

    fn computer_environment(&self, id: String) -> ApplicationFuture<BTreeMap<String, SecretText>> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            credentials::computer_environment(&this.configuration, &id, &root).await
        })
    }

    fn save_computer_environment(
        &self,
        id: String,
        values: BTreeMap<String, SecretText>,
    ) -> ApplicationFuture<()> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            credentials::save_computer_environment(&this.configuration, &id, &root, values).await
        })
    }

    fn delete_computer_key(&self, id: String) -> ApplicationFuture<()> {
        let this = self.0.clone();
        Box::pin(async move {
            let root = this.validated_root()?;
            credentials::delete_computer_key(&this.configuration, &id, &root).await
        })
    }

    fn computer_import_turn(&self, computer_id: String, line: Vec<u8>) -> ApplicationFuture<bool> {
        let memory = self.0.computer_memory.clone();
        Box::pin(async move { memory.import_turn(computer_id, line).await })
    }

    fn computer_session_turns(
        &self,
        computer_id: String,
        runtime_session_id: String,
    ) -> ApplicationFuture<Vec<butler_gateway::gateway::RemovedComputerTurn>> {
        let this = self.0.clone();
        Box::pin(async move {
            computer_memory::session_turns(this.validated_root()?, computer_id, runtime_session_id)
                .await
        })
    }

    fn computer_memory_copy(&self) -> ApplicationFuture<serde_json::Value> {
        let memory = self.0.computer_memory.clone();
        Box::pin(async move { memory.copy().await })
    }

    fn computer_memory_read(
        &self,
        request: serde_json::Value,
    ) -> ApplicationFuture<serde_json::Value> {
        let memory = self.0.computer_memory.clone();
        Box::pin(async move { memory.read(request).await })
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

    fn chatgpt_revision(&self) -> watch::Receiver<u64> {
        self.0.configuration.chatgpt_revision()
    }
    fn chatgpt_account(
        &self,
    ) -> ApplicationFuture<butler_models::models::chatgpt::ChatGptAccountState> {
        chatgpt_account::view(self.0.configuration.clone())
    }
    fn chatgpt_notice(
        &self,
        input: butler_gateway::gateway::ChatGptNoticeInput,
    ) -> ApplicationFuture<butler_models::models::chatgpt::ChatGptAccountState> {
        chatgpt_account::notice(self.0.configuration.clone(), input)
    }
    fn oauth_credentials(
        &self,
    ) -> ApplicationFuture<butler_models::models::chatgpt::credentials::OauthCredentials> {
        chatgpt_account::credentials(self.0.configuration.clone())
    }
    fn remove_oauth_credential(
        &self,
        id: String,
    ) -> ApplicationFuture<butler_models::models::chatgpt::credentials::RemovedOauthCredential>
    {
        chatgpt_account::remove_credential(self.0.configuration.clone(), id)
    }
    fn butler_vault(&self) -> ApplicationFuture<butler_gateway::gateway::ButlerVaultView> {
        butler_vault::view(self.0.data_root.clone())
    }
    fn enable_butler_vault(
        &self,
        password: Option<SecretText>,
    ) -> ApplicationFuture<butler_gateway::gateway::ButlerVaultView> {
        butler_vault::enable(self.0.data_root.clone(), self.0.plugins.clone(), password)
    }
    fn unlock_butler_vault(
        &self,
        password: SecretText,
    ) -> ApplicationFuture<butler_gateway::gateway::ButlerVaultView> {
        butler_vault::unlock(self.0.data_root.clone(), password)
    }
    fn change_butler_vault_password(
        &self,
        current: SecretText,
        new: SecretText,
    ) -> ApplicationFuture<butler_gateway::gateway::ButlerVaultView> {
        butler_vault::password(self.0.data_root.clone(), current, new)
    }
    fn decline_butler_vault(&self) -> ApplicationFuture<butler_gateway::gateway::ButlerVaultView> {
        butler_vault::decline(self.0.data_root.clone())
    }
    fn chatgpt_sign_out(&self) -> ApplicationFuture<butler_gateway::gateway::ChatGptSignOutView> {
        chatgpt_account::sign_out(self.0.configuration.clone())
    }

    fn start_oauth(&self, input: AppOauthStartInput) -> ApplicationFuture<OauthFlowView> {
        let this = self.0.clone();
        Box::pin(async move {
            let remote = butler_models::models::sealed::is_enabled();
            if input.callback_socket && (!remote || input.redirect_port.is_none()) {
                return Err(GatewayApplicationError::Public {
                    status: 400,
                    code: "invalid_request".into(),
                    message: "callback_socket requires redirect_port on a remote computer.".into(),
                    source: None,
                });
            }
            if input.redirect_port.is_some() && !remote {
                return Err(GatewayApplicationError::Public {
                    status: 400,
                    code: "invalid_request".into(),
                    message: "redirect_port is only for remote computers.".into(),
                    source: None,
                });
            }
            let callback_socket = input
                .callback_socket
                .then(|| this.data_root.join("remote/oauth.sock"));
            Ok(this
                .oauth
                .start(
                    input.force,
                    input.kind,
                    input.redirect_port,
                    callback_socket,
                )
                .await)
        })
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
            "auth/computer-key-homes.json",
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
