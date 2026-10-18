//! The ChatGPT sign-in flow table the App starts during
//! first-run setup (#230).
//!
//! Each flow owns a localhost callback listener and its PKCE verifier and
//! state inside one task. Until the provider accepted the code, cancelling
//! ends the task: the listener closes, the PKCE state is dropped and the
//! flow reports `cancelled`. From then on the sign-in is saved whatever
//! happens, so a cancel waits for it and reports its real outcome. A flow
//! with no callback within five minutes
//! fails with `oauth_timeout`.

use std::sync::Arc;
use std::time::Duration;

use crate::host::chatgpt_sign_in::Attempt;
use butler_gateway::gateway::{GatewayApplicationError, OauthFlowStatus, OauthFlowView};
use butler_models::models::{
    ModelConfiguration,
    chatgpt::{SignInKind, SignInOutcome},
};
use parking_lot::Mutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Finished flows kept readable by `GET /setup/oauth/{flow_id}`.
const KEPT_FLOWS: usize = 8;
/// How long cancel waits for the flow task to release its listener, or
/// for a sign-in past the point of no return to be saved.
const CANCEL_WAIT: Duration = Duration::from_secs(10);
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

struct FlowContext {
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
    pub(super) async fn start(&self, force: bool, kind: SignInKind) -> OauthFlowView {
        let _serial = self.starting.lock().await;
        if force {
            self.cancel_open().await;
        } else {
            if let Some(view) = self.open_view() {
                return view;
            }
            if let Ok(account) = self.configuration.chatgpt_account().await
                && matches!(
                    account.status,
                    butler_models::models::chatgpt::ChatGptAccountStatus::SignedIn
                        | butler_models::models::chatgpt::ChatGptAccountStatus::PlanOff
                )
            {
                return self.record(finished(
                    OauthFlowStatus::ProfileExists,
                    account.label,
                    None,
                ));
            }
        }
        match Attempt::start(&self.configuration, kind).await {
            Ok(attempt) => self.spawn(attempt),
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

    fn spawn(&self, attempt: Attempt) -> OauthFlowView {
        let mut view = finished(OauthFlowStatus::Pending, None, None);
        view.auth_url = Some(attempt.auth_url.clone());
        view.redirect_uri = Some(attempt.redirect_uri.clone());
        let stop = CancellationToken::new();
        let context = FlowContext {
            flows: self.flows.clone(),
            flow_id: view.flow_id.clone(),
        };
        let configuration = self.configuration.clone();
        let stopped = stop.clone();
        let mut flows = self.flows.lock();
        let task = tokio::spawn(async move {
            let outcome = attempt
                .run(configuration, stopped, || mark_completing(&context))
                .await;
            settle(&context, outcome);
        });
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

/// Records a finished flow's outcome (a cancelled flow keeps `cancelled`).
fn settle(context: &FlowContext, outcome: Result<SignInOutcome, String>) {
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
        Ok(outcome) => {
            flow.view.status = OauthFlowStatus::Completed;
            flow.view.label = Some(outcome.label);
            flow.view.plan_enabled = Some(outcome.plan_enabled);
        }
        Err(code) => {
            flow.view.status = OauthFlowStatus::Failed;
            flow.view.error = Some(code);
        }
    }
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
        plan_enabled: None,
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
