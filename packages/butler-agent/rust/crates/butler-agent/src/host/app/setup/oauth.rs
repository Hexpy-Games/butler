//! The ChatGPT (Codex subscription) sign-in flow the App starts during
//! first-run setup (#230). Each flow owns a localhost callback listener and
//! its PKCE verifier and state inside one task; cancelling the flow ends the
//! task, which closes the listener and drops the PKCE state. A flow that
//! gets no callback within [`FLOW_TIMEOUT`] fails with `oauth_timeout`.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use butler_gateway::gateway::{GatewayApplicationError, OauthFlowStatus, OauthFlowView};
use butler_models::models::{ModelConfiguration, generate_pkce_verifier, pkce_challenge};

use crate::host::oauth_callback::{CallbackEndpoint, read_callback, respond};

const FLOW_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Finished flows kept readable by `GET /setup/oauth/{flow_id}`.
const KEPT_FLOWS: usize = 8;
/// How long cancel waits for the flow task to release its listener.
const CANCEL_WAIT: Duration = Duration::from_secs(5);

struct Flow {
    view: OauthFlowView,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}

/// The sign-in flows of this process, newest last.
pub(super) struct OauthFlows {
    configuration: Arc<ModelConfiguration>,
    flows: Arc<Mutex<Vec<Flow>>>,
}

/// A started flow's secrets; they live only inside the flow task.
struct Pkce {
    verifier: String,
    state: String,
}

impl OauthFlows {
    pub(super) fn new(configuration: Arc<ModelConfiguration>) -> Self {
        Self {
            configuration,
            flows: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Starts a sign-in. Without `force`, a saved sign-in answers
    /// `profile_exists` and a pending flow is returned as it is.
    pub(super) async fn start(&self, force: bool) -> OauthFlowView {
        if force {
            self.cancel_open().await;
        } else {
            if let Some(view) = self.open_view() {
                return view;
            }
            if let Some(label) = self.configuration.openai_auth_profile_label().await {
                return self.record(finished(OauthFlowStatus::ProfileExists, Some(label), None));
            }
        }
        match self.listen().await {
            Ok((listener, endpoint, pkce, view)) => self.spawn(listener, endpoint, pkce, view),
            Err(code) => self.record(finished(OauthFlowStatus::Failed, None, Some(code))),
        }
    }

    pub(super) fn view(&self, flow_id: &str) -> Result<OauthFlowView, GatewayApplicationError> {
        self.flows
            .lock()
            .iter()
            .find(|flow| flow.view.flow_id == flow_id)
            .map(|flow| flow.view.clone())
            .ok_or_else(flow_not_found)
    }

    /// Cancels an open flow (a finished one is returned unchanged) and waits
    /// until its listener is closed.
    pub(super) async fn cancel(
        &self,
        flow_id: &str,
    ) -> Result<OauthFlowView, GatewayApplicationError> {
        let task = {
            let mut flows = self.flows.lock();
            let flow = flows
                .iter_mut()
                .find(|flow| flow.view.flow_id == flow_id)
                .ok_or_else(flow_not_found)?;
            if flow.view.status.is_open() {
                flow.view.status = OauthFlowStatus::Cancelled;
                flow.stop.cancel();
            }
            flow.task.take()
        };
        if let Some(task) = task {
            let _ = tokio::time::timeout(CANCEL_WAIT, task).await;
        }
        self.view(flow_id)
    }

    /// Cancels every open flow (shutdown, or a forced new sign-in).
    pub(super) async fn cancel_open(&self) {
        let open = self
            .flows
            .lock()
            .iter()
            .filter(|flow| flow.view.status.is_open())
            .map(|flow| flow.view.flow_id.clone())
            .collect::<Vec<_>>();
        for flow_id in open {
            let _ = self.cancel(&flow_id).await;
        }
    }

    fn open_view(&self) -> Option<OauthFlowView> {
        self.flows
            .lock()
            .iter()
            .rev()
            .find(|flow| flow.view.status.is_open())
            .map(|flow| flow.view.clone())
    }

    /// Binds the callback listener and builds the authorization URL.
    async fn listen(&self) -> Result<(TcpListener, CallbackEndpoint, Pkce, OauthFlowView), String> {
        let endpoint = CallbackEndpoint::from_environment()
            .map_err(|_| "oauth_callback_port_invalid".to_owned())?;
        let listener = TcpListener::bind((endpoint.bind_host.as_str(), endpoint.port))
            .await
            .map_err(|_| "oauth_callback_port_unavailable".to_owned())?;
        let pkce = Pkce {
            verifier: generate_pkce_verifier(),
            state: uuid::Uuid::new_v4().simple().to_string(),
        };
        let auth_url = self
            .configuration
            .openai_authorize_url(
                &endpoint.redirect_uri,
                &pkce_challenge(&pkce.verifier),
                &pkce.state,
                None,
            )
            .map_err(|_| "oauth_authorize_url_invalid".to_owned())?;
        let view = OauthFlowView {
            flow_id: new_flow_id(),
            status: OauthFlowStatus::Pending,
            auth_url: Some(auth_url.to_string()),
            redirect_uri: Some(endpoint.redirect_uri.clone()),
            label: None,
            error: None,
        };
        Ok((listener, endpoint, pkce, view))
    }

    fn spawn(
        &self,
        listener: TcpListener,
        endpoint: CallbackEndpoint,
        pkce: Pkce,
        view: OauthFlowView,
    ) -> OauthFlowView {
        let stop = CancellationToken::new();
        let task = tokio::spawn(run_flow(
            listener,
            endpoint.redirect_uri,
            pkce,
            self.configuration.clone(),
            self.flows.clone(),
            view.flow_id.clone(),
            stop.clone(),
        ));
        self.insert(Flow {
            view: view.clone(),
            stop,
            task: Some(task),
        });
        view
    }

    fn record(&self, view: OauthFlowView) -> OauthFlowView {
        self.insert(Flow {
            view: view.clone(),
            stop: CancellationToken::new(),
            task: None,
        });
        view
    }

    fn insert(&self, flow: Flow) {
        let mut flows = self.flows.lock();
        flows.push(flow);
        while flows.len() > KEPT_FLOWS {
            let Some(index) = flows.iter().position(|flow| !flow.view.status.is_open()) else {
                break;
            };
            flows.remove(index);
        }
    }
}

/// An owner that is dropped without `cancel_open` (failed startup) still
/// ends its flows, so no callback listener outlives it.
impl Drop for OauthFlows {
    fn drop(&mut self) {
        for flow in self.flows.lock().iter() {
            flow.stop.cancel();
        }
    }
}

/// Waits for the browser's callback, exchanges the code and saves the
/// sign-in. Ends (dropping the listener and PKCE state) on completion,
/// failure, timeout or `stop`.
async fn run_flow(
    listener: TcpListener,
    redirect_uri: String,
    pkce: Pkce,
    configuration: Arc<ModelConfiguration>,
    flows: Arc<Mutex<Vec<Flow>>>,
    flow_id: String,
    stop: CancellationToken,
) {
    let outcome = tokio::select! {
        outcome = complete(&listener, &redirect_uri, &pkce, &configuration) => outcome,
        () = tokio::time::sleep(FLOW_TIMEOUT) => Err("oauth_timeout".to_owned()),
        () = stop.cancelled() => return,
    };
    drop(listener);
    let mut flows = flows.lock();
    let Some(flow) = flows
        .iter_mut()
        .find(|flow| flow.view.flow_id == flow_id)
        .filter(|flow| flow.view.status.is_open())
    else {
        return;
    };
    match outcome {
        Ok(label) => {
            flow.view.status = OauthFlowStatus::Completed;
            flow.view.label = Some(label);
        }
        Err(code) => {
            flow.view.status = OauthFlowStatus::Failed;
            flow.view.error = Some(code);
        }
    }
}

/// Serves callback requests until one carries this flow's code.
async fn complete(
    listener: &TcpListener,
    redirect_uri: &str,
    pkce: &Pkce,
    configuration: &ModelConfiguration,
) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "oauth_callback_unavailable".to_owned())?;
        let code = match read_callback(&mut stream, redirect_uri, &pkce.state).await {
            Ok(Some(code)) => code,
            Ok(None) => continue,
            Err(error) => return Err(error.code().to_owned()),
        };
        let saved = match configuration
            .exchange_openai_oauth_code(&code, redirect_uri, &pkce.verifier)
            .await
        {
            Ok(profile) => configuration
                .write_openai_auth_profile(&profile)
                .await
                .map(|()| profile),
            Err(error) => Err(error),
        };
        return match saved {
            Ok(profile) => {
                respond(
                    &mut stream,
                    200,
                    "Codex subscription login complete. You can close this tab.",
                )
                .await;
                Ok(account_label(&profile.as_json()))
            }
            Err(_) => {
                respond(&mut stream, 500, "Codex subscription login failed.").await;
                Err("oauth_exchange_failed".to_owned())
            }
        };
    }
}

fn account_label(profile: &serde_json::Value) -> String {
    ["email", "accountId"]
        .iter()
        .find_map(|key| profile.get(*key).and_then(serde_json::Value::as_str))
        .filter(|value| !value.is_empty())
        .unwrap_or("OpenAI account")
        .to_owned()
}

fn finished(
    status: OauthFlowStatus,
    label: Option<String>,
    error: Option<String>,
) -> OauthFlowView {
    OauthFlowView {
        flow_id: new_flow_id(),
        status,
        auth_url: None,
        redirect_uri: None,
        label,
        error,
    }
}

fn new_flow_id() -> String {
    format!("oauth_{}", uuid::Uuid::new_v4().simple())
}

fn flow_not_found() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "oauth_flow_not_found".into(),
        message: "This sign-in is not known to the agent.".into(),
        source: None,
    }
}
