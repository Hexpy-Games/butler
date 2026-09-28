//! First-run setup (#230): the agent's own preparation, local model
//! servers, API key checks and saving, and the ChatGPT sign-in flow. The
//! host does the work behind [`AppSetupPort`]; the App API exposes it, and
//! readiness changes become the live event `setup.readiness_changed`.

use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use butler_models::models::{CredentialView, DetectedLocalServer};

use super::{AppIdentityClock, AppStorage, EventSubscribers, events};
use crate::gateway::ApplicationFuture;

/// The live event that carries a new [`SetupReadinessView`] as its payload.
pub const SETUP_READINESS_EVENT: &str = "setup.readiness_changed";

/// `GET /setup/readiness`: the agent's own preparation and its steps.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SetupReadinessView {
    pub status: SetupReadinessStatus,
    pub steps: Vec<SetupReadinessStep>,
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

/// Body of `POST /setup/oauth/start`.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppOauthStartInput {
    /// Start a new sign-in even when one is saved.
    #[serde(default)]
    pub force: bool,
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
    /// The signed-in account (email or account id).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Stable failure code of a `failed` flow.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OauthFlowStatus {
    Starting,
    Pending,
    Completed,
    ProfileExists,
    Cancelled,
    Failed,
}

impl OauthFlowStatus {
    /// Whether the flow still holds a callback listener.
    pub fn is_open(self) -> bool {
        matches!(self, Self::Starting | Self::Pending)
    }
}

/// First-run setup operations owned by the host.
pub trait AppSetupPort: Send + Sync + 'static {
    /// The current readiness; the receiver wakes on every change.
    fn readiness(&self) -> watch::Receiver<SetupReadinessView>;
    /// Runs the preparation again (after a failure) and returns its view.
    fn retry_readiness(&self) -> SetupReadinessView;
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
    fn start_oauth(&self, input: AppOauthStartInput) -> ApplicationFuture<OauthFlowView>;
    fn oauth_flow(&self, flow_id: String) -> ApplicationFuture<OauthFlowView>;
    /// Closes the flow's callback listener and drops its PKCE state.
    fn cancel_oauth(&self, flow_id: String) -> ApplicationFuture<OauthFlowView>;
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
        readiness.borrow_and_update();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    changed = readiness.changed() => if changed.is_err() { break },
                    () = stopped.cancelled() => break,
                }
                let view = readiness.borrow_and_update().clone();
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

/// A ready setup port for tests that do not exercise first-run setup.
#[cfg(test)]
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
        status: SetupReadinessStatus::Ready,
        steps: Vec::new(),
    };
    Arc::new(Ready(watch::channel(ready).0))
}
