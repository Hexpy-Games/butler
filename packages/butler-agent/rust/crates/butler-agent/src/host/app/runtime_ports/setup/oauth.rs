//! The ChatGPT (Codex subscription) sign-in flow the App starts during
//! first-run setup (#230).
//!
//! Each flow owns a localhost callback listener and its PKCE verifier and
//! state inside one task. Until the provider accepted the code, cancelling
//! ends the task: the listener closes, the PKCE state is dropped and the
//! flow reports `cancelled`. From then on the sign-in is saved whatever
//! happens, so a cancel waits for it and reports its real outcome. A flow
//! with no callback within [`FLOW_TIMEOUT`] (the App's own sign-in timeout)
//! fails with `oauth_timeout`.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::{
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

use butler_gateway::gateway::{GatewayApplicationError, OauthFlowStatus, OauthFlowView};
use butler_models::models::{
    ModelConfiguration, OpenAiAuthProfile, generate_pkce_verifier, pkce_challenge,
};

use crate::host::oauth_callback::{Callback, CallbackEndpoint, read_callback, respond};

const FLOW_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Finished flows kept readable by `GET /setup/oauth/{flow_id}`.
const KEPT_FLOWS: usize = 8;
/// How long cancel waits for the flow task to release its listener, or
/// for a sign-in past the point of no return to be saved.
const CANCEL_WAIT: Duration = Duration::from_secs(10);
/// Callback connections read at once; more are closed unread.
const MAX_OPEN_CALLBACKS: usize = 16;

struct Flow {
    view: OauthFlowView,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
    /// The provider accepted the code: the sign-in is being saved and can
    /// no longer be cancelled.
    completing: bool,
}

type FlowTable = Arc<Mutex<Vec<Flow>>>;

/// The sign-in flows of this process, newest last.
pub(super) struct OauthFlows {
    configuration: Arc<ModelConfiguration>,
    flows: FlowTable,
    /// One start at a time: two concurrent starts would race for the port.
    starting: tokio::sync::Mutex<()>,
}

/// A started flow's secrets; they live only inside the flow task.
struct Pkce {
    verifier: String,
    state: String,
}

/// What a flow task needs besides its listener and secrets.
struct FlowContext {
    redirect_uri: String,
    configuration: Arc<ModelConfiguration>,
    flows: FlowTable,
    flow_id: String,
}

impl OauthFlows {
    pub(super) fn new(configuration: Arc<ModelConfiguration>) -> Self {
        Self {
            configuration,
            flows: Arc::new(Mutex::new(Vec::new())),
            starting: tokio::sync::Mutex::new(()),
        }
    }

    /// Starts a sign-in. Without `force`, a saved sign-in answers
    /// `profile_exists` and a pending flow is returned as it is.
    pub(super) async fn start(&self, force: bool) -> OauthFlowView {
        let _serial = self.starting.lock().await;
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

    /// Cancels a pending flow and waits until its listener is closed. A
    /// flow past the point of no return, or already finished, is not
    /// cancelled: its real outcome is returned.
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
            if flow.view.status.is_open() && !flow.completing {
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
        let context = FlowContext {
            redirect_uri: endpoint.redirect_uri,
            configuration: self.configuration.clone(),
            flows: self.flows.clone(),
            flow_id: view.flow_id.clone(),
        };
        // Registered before the task runs, so the task always finds it.
        let mut flows = self.flows.lock();
        let task = tokio::spawn(run_flow(listener, pkce, context, stop.clone()));
        insert(
            &mut flows,
            Flow {
                view: view.clone(),
                stop,
                task: Some(task),
                completing: false,
            },
        );
        view
    }

    fn record(&self, view: OauthFlowView) -> OauthFlowView {
        insert(
            &mut self.flows.lock(),
            Flow {
                view: view.clone(),
                stop: CancellationToken::new(),
                task: None,
                completing: false,
            },
        );
        view
    }
}

fn insert(flows: &mut Vec<Flow>, flow: Flow) {
    flows.push(flow);
    while flows.len() > KEPT_FLOWS {
        let Some(index) = flows.iter().position(|flow| !flow.view.status.is_open()) else {
            break;
        };
        flows.remove(index);
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

/// Waits for this sign-in's callback and exchanges its code (cancellable),
/// then saves the sign-in (not cancellable) and records the outcome.
async fn run_flow(
    listener: TcpListener,
    pkce: Pkce,
    context: FlowContext,
    stop: CancellationToken,
) {
    let exchanged = tokio::select! {
        exchanged = exchange(&listener, &pkce, &context) => exchanged,
        () = tokio::time::sleep(FLOW_TIMEOUT) => Err("oauth_timeout".to_owned()),
        () = stop.cancelled() => return,
    };
    drop(listener);
    drop(pkce);
    let outcome = match exchanged {
        Ok((profile, mut stream)) => {
            if !mark_completing(&context) {
                respond(&mut stream, 409, "This sign-in was cancelled in Butler.").await;
                return;
            }
            save(&context, &profile, stream).await
        }
        Err(code) => Err(code),
    };
    settle(&context, outcome);
}

/// Moves the flow past the point of no return, unless it was cancelled.
fn mark_completing(context: &FlowContext) -> bool {
    let mut flows = context.flows.lock();
    let flow = flows
        .iter_mut()
        .find(|flow| flow.view.flow_id == context.flow_id)
        .filter(|flow| flow.view.status.is_open());
    match flow {
        Some(flow) => {
            flow.completing = true;
            true
        }
        None => false,
    }
}

/// Saves the exchanged sign-in and answers the browser.
async fn save(
    context: &FlowContext,
    profile: &OpenAiAuthProfile,
    mut stream: TcpStream,
) -> Result<String, String> {
    match context
        .configuration
        .write_openai_auth_profile(profile)
        .await
    {
        Ok(()) => {
            let done = "Codex subscription login complete. You can close this tab.";
            respond(&mut stream, 200, done).await;
            Ok(account_label(&profile.as_json()))
        }
        Err(_) => {
            respond(&mut stream, 500, "Codex subscription login failed.").await;
            Err("oauth_profile_write_failed".to_owned())
        }
    }
}

/// Records a finished flow's outcome (a cancelled flow keeps `cancelled`).
fn settle(context: &FlowContext, outcome: Result<String, String>) {
    let mut flows = context.flows.lock();
    let Some(flow) = flows
        .iter_mut()
        .find(|flow| flow.view.flow_id == context.flow_id)
        .filter(|flow| flow.view.status.is_open())
    else {
        return;
    };
    flow.completing = false;
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

/// Waits for this sign-in's code and exchanges it with the provider.
async fn exchange(
    listener: &TcpListener,
    pkce: &Pkce,
    context: &FlowContext,
) -> Result<(OpenAiAuthProfile, TcpStream), String> {
    let (code, mut stream) = wait_for_code(listener, &context.redirect_uri, &pkce.state).await?;
    match context
        .configuration
        .exchange_openai_oauth_code(&code, &context.redirect_uri, &pkce.verifier)
        .await
    {
        Ok(profile) => Ok((profile, stream)),
        Err(_) => {
            respond(&mut stream, 500, "Codex subscription login failed.").await;
            Err("oauth_exchange_failed".to_owned())
        }
    }
}

/// Reads callback connections side by side, so an idle or stray one never
/// holds up the browser's; each read is bounded by the callback reader.
async fn wait_for_code(
    listener: &TcpListener,
    redirect_uri: &str,
    state: &str,
) -> Result<(String, TcpStream), String> {
    let mut reads = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(|_| "oauth_callback_unavailable".to_owned())?;
                if reads.len() < MAX_OPEN_CALLBACKS {
                    reads.spawn(read_one(stream, redirect_uri.to_owned(), state.to_owned()));
                }
            }
            Some(read) = reads.join_next() => match read {
                Ok((Callback::Code(code), stream)) => return Ok((code, stream)),
                Ok((Callback::Denied, _)) => return Err("oauth_denied".to_owned()),
                Ok((Callback::Ignored, _)) | Err(_) => {}
            },
        }
    }
}

async fn read_one(
    mut stream: TcpStream,
    redirect_uri: String,
    state: String,
) -> (Callback, TcpStream) {
    let callback = read_callback(&mut stream, &redirect_uri, &state).await;
    (callback, stream)
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
