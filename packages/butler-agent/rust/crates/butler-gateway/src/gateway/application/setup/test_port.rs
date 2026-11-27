//! A ready setup port for unit tests.
use super::*;

/// A ready setup port for tests that do not exercise first-run setup.
pub(crate) fn test_setup_port() -> Arc<dyn AppSetupPort> {
    struct Ready(watch::Sender<SetupReadinessView>);
    fn unsupported<T: Send + 'static>() -> ApplicationFuture<T> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
    impl AppSetupPort for Ready {
        fn readiness(&self) -> watch::Receiver<SetupReadinessView> {
            self.0.subscribe()
        }
        fn retry_readiness(&self) -> SetupReadinessView {
            self.0.borrow().clone()
        }
        fn local_model_servers(&self) -> ApplicationFuture<LocalModelServersView> {
            unsupported()
        }
        fn verify_provider_key(
            &self,
            _: AppProviderKeyInput,
        ) -> ApplicationFuture<ProviderKeyVerificationView> {
            unsupported()
        }
        fn save_provider_key(
            &self,
            _: AppProviderKeyInput,
        ) -> ApplicationFuture<SavedCredentialView> {
            unsupported()
        }
        fn saved_provider_key(&self, _: String) -> ApplicationFuture<SavedProviderKey> {
            unsupported()
        }
        fn computer_key(&self, _: String) -> ApplicationFuture<SecretText> {
            unsupported()
        }
        fn device_ssh_key(
            &self,
            _: Option<DeviceSshKey>,
        ) -> ApplicationFuture<Option<DeviceSshKey>> {
            Box::pin(async { Ok(None) })
        }
        fn computer_environment(
            &self,
            _: String,
        ) -> ApplicationFuture<BTreeMap<String, SecretText>> {
            unsupported()
        }
        fn save_computer_environment(
            &self,
            _: String,
            _: BTreeMap<String, SecretText>,
        ) -> ApplicationFuture<()> {
            unsupported()
        }
        fn delete_computer_key(&self, _: String) -> ApplicationFuture<()> {
            unsupported()
        }
        fn list_credentials(&self) -> ApplicationFuture<CredentialList> {
            unsupported()
        }
        fn replace_credential(
            &self,
            _: String,
            _: AppCredentialReplaceInput,
        ) -> ApplicationFuture<ReplacedCredentialView> {
            unsupported()
        }
        fn delete_credential(&self, _: String, _: bool) -> ApplicationFuture<DeletedCredential> {
            unsupported()
        }
        fn chatgpt_revision(&self) -> watch::Receiver<u64> {
            watch::channel(0).1
        }
        fn chatgpt_account(
            &self,
        ) -> ApplicationFuture<butler_models::models::chatgpt::ChatGptAccountState> {
            unsupported()
        }
        fn chatgpt_notice(
            &self,
            _: ChatGptNoticeInput,
        ) -> ApplicationFuture<butler_models::models::chatgpt::ChatGptAccountState> {
            unsupported()
        }
        fn oauth_credentials(
            &self,
        ) -> ApplicationFuture<butler_models::models::chatgpt::credentials::OauthCredentials>
        {
            unsupported()
        }
        fn remove_oauth_credential(
            &self,
            _: String,
        ) -> ApplicationFuture<butler_models::models::chatgpt::credentials::RemovedOauthCredential>
        {
            unsupported()
        }
        fn butler_vault(&self) -> ApplicationFuture<ButlerVaultView> {
            unsupported()
        }
        fn enable_butler_vault(&self, _: Option<SecretText>) -> ApplicationFuture<ButlerVaultView> {
            unsupported()
        }
        fn unlock_butler_vault(&self, _: SecretText) -> ApplicationFuture<ButlerVaultView> {
            unsupported()
        }
        fn change_butler_vault_password(
            &self,
            _: SecretText,
            _: SecretText,
        ) -> ApplicationFuture<ButlerVaultView> {
            unsupported()
        }
        fn decline_butler_vault(&self) -> ApplicationFuture<ButlerVaultView> {
            unsupported()
        }
        fn chatgpt_sign_out(&self) -> ApplicationFuture<ChatGptSignOutView> {
            unsupported()
        }
        fn start_oauth(&self, _: AppOauthStartInput) -> ApplicationFuture<OauthFlowView> {
            unsupported()
        }
        fn oauth_flow(&self, _: String) -> ApplicationFuture<OauthFlowView> {
            unsupported()
        }
        fn cancel_oauth(&self, _: String) -> ApplicationFuture<OauthFlowView> {
            unsupported()
        }
    }
    let ready = SetupReadinessView {
        memory_model: None,
        status: SetupReadinessStatus::Ready,
        steps: Vec::new(),
    };
    Arc::new(Ready(watch::channel(ready).0))
}
