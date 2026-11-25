//! First-run setup (#230): the agent's own preparation, local model
//! servers, API key checks and saving, and the ChatGPT sign-in flow. The
//! host does the work behind [`AppSetupPort`]; the App API exposes it, and
//! readiness changes become the live event `setup.readiness_changed`.

pub(crate) mod butler_account;
pub(crate) mod butler_backup;
pub(crate) mod publishing;
use butler_account::{ButlerAccountRequest, butler_account_disabled};
use butler_backup::ButlerBackupRequest;
use publishing::PublishingRequest;

use butler_platform::secrets::SecretText;
use std::collections::BTreeMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use butler_models::models::{
    CredentialList, CredentialView, DeletedCredential, DetectedLocalServer,
};

use super::{AppIdentityClock, AppStorage, EventSubscribers, events};
use crate::gateway::ApplicationFuture;

/// The live event that carries a new [`SetupReadinessView`] as its payload.
pub const SETUP_READINESS_EVENT: &str = "setup.readiness_changed";

/// `GET /setup/readiness`: the agent's own preparation and its steps.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SetupReadinessView {
    pub status: SetupReadinessStatus,
    pub steps: Vec<SetupReadinessStep>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_model: Option<MemoryModelProgress>,
}

/// In-memory acquisition status; never gates setup or chat.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct MemoryModelProgress {
    pub state: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupReadinessStatus {
    Preparing,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SetupReadinessStep {
    /// Stable step id; the App names the step.
    pub id: String,
    pub status: SetupStepStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SetupStepError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupStepStatus {
    Pending,
    Running,
    Done,
    Failed,
}

/// Why a step failed: a stable `code` the App maps to a plain reason, and
/// an English `detail` for bug reports (no paths, no secrets).
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SetupStepError {
    pub code: String,
    pub detail: String,
}

/// `GET /setup/local-model-servers`.
#[derive(Clone, Debug, Serialize)]
pub struct LocalModelServersView {
    pub servers: Vec<DetectedLocalServer>,
}

/// Body of `POST /setup/credentials/verify` and `POST /credentials`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppProviderKeyInput {
    pub provider_id: String,
    pub api_key: String,
}

/// A saved key read for an explicit owner action; never serialized.
pub struct SavedProviderKey {
    pub provider_id: String,
    pub api_key: SecretText,
}

/// A key the provider did not reject; failures are error envelopes.
#[derive(Clone, Debug, Serialize)]
pub struct ProviderKeyVerificationView {
    pub valid: bool,
    /// False when the provider has no model list to check the key against.
    pub verified: bool,
    pub models: Vec<String>,
}

/// `POST /credentials`: the saved (or already saved) key, masked.
#[derive(Clone, Serialize)]
pub struct SavedCredentialView {
    pub credential: CredentialView,
    /// False when the same key was already saved and is reused.
    pub created: bool,
}

/// Body of `PATCH /credentials/{name}` (#217).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppCredentialReplaceInput {
    pub api_key: String,
    /// Check the new key with the provider first (as
    /// `POST /setup/credentials/verify` does); a rejected key changes
    /// nothing.
    #[serde(default)]
    pub verify: bool,
}

/// `PATCH /credentials/{name}`: the key after the replacement, masked.
#[derive(Clone, Serialize)]
pub struct ReplacedCredentialView {
    pub credential: CredentialView,
}

/// Body of `POST /setup/oauth/start`.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppOauthStartInput {
    /// Start a new sign-in even when one is saved.
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub kind: butler_models::models::chatgpt::SignInKind,
    #[serde(default)]
    pub redirect_port: Option<u16>,
    #[serde(default)]
    pub callback_socket: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatGptNoticeInput {
    pub kind: ChatGptNoticeKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatGptNoticeKind {
    Plan,
    Legacy,
}
#[derive(Serialize)]
pub struct ChatGptSignOutView {
    pub revoked: bool,
    pub account: butler_models::models::chatgpt::ChatGptAccountState,
}

/// `GET /setup/butler-vault`, and the answer of enable/decline.
#[derive(Clone, Debug, Serialize)]
pub struct ButlerVaultView {
    /// `protected` (in use and open), `off` (not turned on, or declined), `locked` (in use, the keychain key did not open).
    pub state: &'static str,
    /// The vault opens unattended on this host (keychain or sealed); when false
    /// only the master password can open it.
    pub available: bool,
    /// Why only the master password can open a vault here: `unsigned_build`
    /// when the keychain is withheld only because this build is not
    /// Developer ID signed (macOS development builds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_reason: Option<&'static str>,
    /// How the vault in use opens: `keychain`, `sealed` or `password`.
    pub unlock: Option<&'static str>,
    /// A master password is set.
    pub has_password: bool,
    /// The user chose "사용 안 함".
    pub declined: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<ButlerVaultCounts>,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct ButlerVaultCounts {
    pub api_key: usize,
    pub signin: usize,
    pub card: usize,
    pub profile: usize,
    pub plugin: usize,
}

/// A ChatGPT sign-in flow.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OauthFlowView {
    pub flow_id: String,
    pub status: OauthFlowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redirect_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub callback_port: Option<u16>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub callback_socket: bool,
    /// The signed-in account (email or account id).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Stable failure code of a `failed` flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_enabled: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OauthFlowStatus {
    /// Waiting for the browser (the agent's flow starts pending: the
    /// listener is bound before the answer).
    Pending,
    Completed,
    ProfileExists,
    Cancelled,
    Failed,
}

impl OauthFlowStatus {
    /// Whether the flow still holds a callback listener.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Pending)
    }
}

/// First-run setup operations owned by the host.
pub trait AppSetupPort: Send + Sync + 'static {
    /// The current readiness; the receiver wakes on every change.
    fn readiness(&self) -> watch::Receiver<SetupReadinessView>;
    /// Runs the preparation again (after a failure) and returns its view.
    fn retry_readiness(&self) -> SetupReadinessView;
    /// Retries optional acquisition without changing setup eligibility.
    fn retry_memory_model(&self) -> SetupReadinessView {
        self.readiness().borrow().clone()
    }
    /// Persists the memory-model choice: on downloads it in the background, off
    /// stops it and keeps memory text-only. Never changes setup eligibility.
    fn choose_memory_model(&self, _enabled: bool) -> ApplicationFuture<SetupReadinessView> {
        let view = self.readiness().borrow().clone();
        Box::pin(async move { Ok(view) })
    }
    fn local_model_servers(&self) -> ApplicationFuture<LocalModelServersView>;
    /// Checks a key with the provider; nothing is stored.
    fn verify_provider_key(
        &self,
        input: AppProviderKeyInput,
    ) -> ApplicationFuture<ProviderKeyVerificationView>;
    /// Stores a key under a generated name (provider id, then `-2`, `-3`, ...).
    fn save_provider_key(
        &self,
        input: AppProviderKeyInput,
    ) -> ApplicationFuture<SavedCredentialView>;
    /// The saved keys (masked, with their store and the models using them)
    /// and where new keys go.
    fn list_credentials(&self) -> ApplicationFuture<CredentialList>;
    fn saved_provider_key(&self, name: String) -> ApplicationFuture<SavedProviderKey>;
    /// The main's model plan for a computer (`None` = follow the default model). Reads no secret.
    fn computer_model(
        &self,
        _credential_id: Option<String>,
    ) -> ApplicationFuture<butler_models::models::ComputerModel> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
    fn computer_key(&self, id: String) -> ApplicationFuture<SecretText>;
    fn computer_environment(&self, id: String) -> ApplicationFuture<BTreeMap<String, SecretText>>;
    fn save_computer_environment(
        &self,
        id: String,
        values: BTreeMap<String, SecretText>,
    ) -> ApplicationFuture<()>;
    fn delete_computer_key(&self, id: String) -> ApplicationFuture<()>;
    /// Import a finished turn from a registered computer.
    fn computer_import_turn(
        &self,
        _computer_id: String,
        _line: Vec<u8>,
    ) -> ApplicationFuture<bool> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
    /// The read-only memory copy the main hands a registered computer on connect.
    fn computer_memory_copy(&self) -> ApplicationFuture<Value> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
    /// Answers a registered computer's conversation memory read from the main's memory.
    fn computer_memory_read(&self, _request: Value) -> ApplicationFuture<Value> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
    /// Replaces the key of the saved credential `name` (its id, or its
    /// label when exactly one key has it).
    fn replace_credential(
        &self,
        name: String,
        input: AppCredentialReplaceInput,
    ) -> ApplicationFuture<ReplacedCredentialView>;
    /// Deletes the saved credential `name` and its key. A key the default
    /// model uses is refused; one other models use is refused unless
    /// `force`, which unregisters those models.
    fn delete_credential(&self, name: String, force: bool) -> ApplicationFuture<DeletedCredential>;
    fn chatgpt_revision(&self) -> watch::Receiver<u64>;
    fn chatgpt_account(
        &self,
    ) -> ApplicationFuture<butler_models::models::chatgpt::ChatGptAccountState>;
    fn chatgpt_notice(
        &self,
        input: ChatGptNoticeInput,
    ) -> ApplicationFuture<butler_models::models::chatgpt::ChatGptAccountState>;
    fn oauth_credentials(
        &self,
    ) -> ApplicationFuture<butler_models::models::chatgpt::credentials::OauthCredentials>;
    fn remove_oauth_credential(
        &self,
        id: String,
    ) -> ApplicationFuture<butler_models::models::chatgpt::credentials::RemovedOauthCredential>;
    fn butler_vault(&self) -> ApplicationFuture<ButlerVaultView>;
    fn enable_butler_vault(
        &self,
        password: Option<SecretText>,
    ) -> ApplicationFuture<ButlerVaultView>;
    fn unlock_butler_vault(&self, password: SecretText) -> ApplicationFuture<ButlerVaultView>;
    fn change_butler_vault_password(
        &self,
        current: SecretText,
        new: SecretText,
    ) -> ApplicationFuture<ButlerVaultView>;
    fn decline_butler_vault(&self) -> ApplicationFuture<ButlerVaultView>;
    fn chatgpt_sign_out(&self) -> ApplicationFuture<ChatGptSignOutView>;
    fn start_oauth(&self, input: AppOauthStartInput) -> ApplicationFuture<OauthFlowView>;
    fn oauth_flow(&self, flow_id: String) -> ApplicationFuture<OauthFlowView>;
    /// Closes the flow's callback listener and drops its PKCE state.
    fn cancel_oauth(&self, flow_id: String) -> ApplicationFuture<OauthFlowView>;

    /// The Butler account; off unless `butlerAccountEnabled`.
    fn butler_backup(&self, _request: ButlerBackupRequest) -> ApplicationFuture<Value> {
        Box::pin(async { Err(butler_account_disabled()) })
    }

    fn butler_account(
        &self,
        _request: ButlerAccountRequest,
    ) -> ApplicationFuture<serde_json::Value> {
        Box::pin(async { Err(butler_account_disabled()) })
    }

    /// Publishing to the web; off unless `butlerAccountEnabled`.
    fn publishing(&self, _request: PublishingRequest) -> ApplicationFuture<Value> {
        Box::pin(async { Err(butler_account_disabled()) })
    }
}

/// Appends a `setup.readiness_changed` event for every readiness change
/// while dispatch runs. Changes that follow each other quickly may arrive
/// as one event with the latest view.
#[derive(Default)]
pub(super) struct ReadinessRelay {
    running: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}

impl ReadinessRelay {
    pub(super) fn start(
        &self,
        mut readiness: watch::Receiver<SetupReadinessView>,
        storage: AppStorage,
        subscribers: EventSubscribers,
        clock: Arc<dyn AppIdentityClock>,
    ) {
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        // The view at start is what `GET /setup/readiness` answers; only
        // later changes become events.
        // Memory progress is read from the live view, never from persisted timeline events.
        let mut previous = readiness.borrow_and_update().clone();
        previous.memory_model = None;
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = readiness.changed() => if changed.is_err() { break },
                    () = stopped.cancelled() => break,
                }
                let mut view = readiness.borrow_and_update().clone();
                view.memory_model = None;
                if view == previous {
                    continue;
                }
                previous = view.clone();
                append(&storage, &subscribers, clock.as_ref(), &view).await;
            }
        });
        if let Some((previous, _)) = self.running.lock().replace((stop, task)) {
            previous.cancel();
        }
    }

    pub(super) async fn close(&self) {
        let running = self.running.lock().take();
        if let Some((stop, task)) = running {
            stop.cancel();
            let _ = task.await;
        }
    }
}

/// A failed append is not retried: readiness stays readable by
/// `GET /setup/readiness`, and the next change appends again.
async fn append(
    storage: &AppStorage,
    subscribers: &EventSubscribers,
    clock: &dyn AppIdentityClock,
    view: &SetupReadinessView,
) {
    let Ok(Value::Object(payload)) = serde_json::to_value(view) else {
        return;
    };
    let subscribers = subscribers.clone();
    let now = clock.now_iso();
    let _ = storage
        .execute(move |db| {
            events::append(db, &subscribers, SETUP_READINESS_EVENT, None, payload, &now).map(|_| ())
        })
        .await;
}

#[cfg(test)]
mod test_port;
#[cfg(test)]
pub(crate) use test_port::test_setup_port;
