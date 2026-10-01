//! The agent's own background preparation (#230), reported by
//! `GET /setup/readiness` and the live event `setup.readiness_changed`.
//!
//! Steps, in order; the first failure stops the run with its reason, and a
//! step that does not finish in time fails with `<step>_timed_out`:
//! - `data_folder`: the data folder takes a write (a probe file is written
//!   and removed again).
//! - `model_config`: the model configuration and saved keys can be read.
//! - `agent_runtime`: the turn executor has published that it is ready.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use butler_gateway::gateway::{
    SetupReadinessStatus, SetupReadinessStep, SetupReadinessView, SetupStepError, SetupStepStatus,
};
use butler_models::models::ModelConfiguration;
use butler_runtime::operations::ServiceReadiness;

/// Written and removed by the `data_folder` step.
const PROBE_FILE: &str = "state/setup-readiness.probe";
const EXECUTOR_WAIT: Duration = Duration::from_secs(60);
/// Longest a file or configuration step may take.
const STEP_TIMEOUT: Duration = Duration::from_secs(15);
const EXECUTOR_POLL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy)]
enum Step {
    DataFolder,
    ModelConfig,
    AgentRuntime,
}

impl Step {
    const ALL: [Self; 3] = [Self::DataFolder, Self::ModelConfig, Self::AgentRuntime];

    fn id(self) -> &'static str {
        match self {
            Self::DataFolder => "data_folder",
            Self::ModelConfig => "model_config",
            Self::AgentRuntime => "agent_runtime",
        }
    }

    /// The longest the step may take; the executor gets the most, since a
    /// cold start opens the stores first.
    fn timeout(self) -> Duration {
        match self {
            Self::DataFolder | Self::ModelConfig => STEP_TIMEOUT,
            Self::AgentRuntime => EXECUTOR_WAIT + STEP_TIMEOUT,
        }
    }

    /// The failure of a step that did not finish within its timeout.
    fn timed_out(self) -> SetupStepError {
        SetupStepError {
            code: format!("{}_timed_out", self.id()),
            detail: "The step did not finish in time.".to_owned(),
        }
    }
}

/// What the steps check.
pub(super) struct ReadinessChecks {
    pub(super) data_root: PathBuf,
    pub(super) configuration: Arc<ModelConfiguration>,
    pub(super) executor: Arc<ServiceReadiness>,
}

/// One preparation run at a time; a retry starts the next one.
pub(super) struct Preparation {
    checks: Arc<ReadinessChecks>,
    state: watch::Sender<SetupReadinessView>,
    run: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
    acquisition: Arc<crate::host::embedding::worker::assets::Acquisition>,
    memory_relay: JoinHandle<()>,
}

impl Preparation {
    /// Starts the first run.
    pub(super) fn start(
        checks: ReadinessChecks,
        acquisition: Arc<crate::host::embedding::worker::assets::Acquisition>,
    ) -> Self {
        let mut initial = initial_view();
        initial.memory_model = Some(acquisition.subscribe().borrow().clone());
        let state = watch::channel(initial).0;
        let mut progress = acquisition.subscribe();
        let relay_state = state.clone();
        let memory_relay = tokio::spawn(async move {
            loop {
                let model = progress.borrow_and_update().clone();
                relay_state.send_modify(|view| view.memory_model = Some(model));
                if progress.changed().await.is_err() {
                    break;
                }
            }
        });
        let preparation = Self {
            checks: Arc::new(checks),
            state,
            acquisition,
            memory_relay,
            run: Mutex::new(None),
        };
        preparation.begin();
        preparation
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<SetupReadinessView> {
        self.state.subscribe()
    }

    /// Starts a new run, replacing one that is still going (a stuck run
    /// ends at its step timeout anyway); returns the view.
    pub(super) fn retry(&self) -> SetupReadinessView {
        self.begin();
        self.retry_memory_model()
    }

    /// Optional model work never resets the setup's readiness steps.
    pub(super) fn retry_memory_model(&self) -> SetupReadinessView {
        self.acquisition.retry();
        self.state.send_modify(|view| {
            view.memory_model = Some(self.acquisition.subscribe().borrow().clone());
        });
        self.state.borrow().clone()
    }

    pub(super) async fn close(&self) {
        self.memory_relay.abort();
        let run = self.run.lock().take();
        if let Some((stop, task)) = run {
            stop.cancel();
            let _ = task.await;
        }
    }

    fn begin(&self) {
        let mut run_slot = self.run.lock();
        // The previous run stops before the view resets, so it can publish
        // nothing into the new run's view.
        if let Some((previous, _)) = run_slot.take() {
            previous.cancel();
        }
        self.state.send_modify(|view| {
            let memory_model = view.memory_model.take();
            *view = initial_view();
            view.memory_model = memory_model;
        });
        let stop = CancellationToken::new();
        let task = tokio::spawn(run(self.checks.clone(), self.state.clone(), stop.clone()));
        *run_slot = Some((stop, task));
    }
}

impl Drop for Preparation {
    fn drop(&mut self) {
        self.memory_relay.abort();
        if let Some((stop, _)) = self.run.get_mut().take() {
            stop.cancel();
        }
    }
}

fn initial_view() -> SetupReadinessView {
    SetupReadinessView {
        memory_model: None,
        status: SetupReadinessStatus::Preparing,
        steps: Step::ALL
            .iter()
            .map(|step| SetupReadinessStep {
                id: step.id().to_owned(),
                status: SetupStepStatus::Pending,
                error: None,
            })
            .collect(),
    }
}

/// Runs the steps in order and publishes every change.
async fn run(
    checks: Arc<ReadinessChecks>,
    state: watch::Sender<SetupReadinessView>,
    stop: CancellationToken,
) {
    for (index, step) in Step::ALL.into_iter().enumerate() {
        publish(&state, &stop, |view| {
            view.steps[index].status = SetupStepStatus::Running;
        });
        let outcome = tokio::select! {
            outcome = tokio::time::timeout(step.timeout(), checks.check(step)) => {
                outcome.unwrap_or_else(|_| Err(step.timed_out()))
            }
            () = stop.cancelled() => return,
        };
        let failed = outcome.is_err();
        publish(&state, &stop, |view| {
            let entry = &mut view.steps[index];
            match outcome {
                Ok(()) => entry.status = SetupStepStatus::Done,
                Err(error) => {
                    entry.status = SetupStepStatus::Failed;
                    entry.error = Some(error);
                    view.status = SetupReadinessStatus::Failed;
                }
            }
        });
        if failed || stop.is_cancelled() {
            return;
        }
    }
    publish(&state, &stop, |view| {
        view.status = SetupReadinessStatus::Ready;
    });
}

/// Changes the view unless this run was replaced. The check runs under the
/// view's own lock, after which a replacing run resets the view, so a
/// replaced run can never write into its successor's view.
fn publish(
    state: &watch::Sender<SetupReadinessView>,
    stop: &CancellationToken,
    change: impl FnOnce(&mut SetupReadinessView),
) {
    state.send_if_modified(|view| {
        if stop.is_cancelled() {
            return false;
        }
        change(view);
        true
    });
}

impl ReadinessChecks {
    async fn check(&self, step: Step) -> Result<(), SetupStepError> {
        match step {
            Step::DataFolder => self.data_folder().await,
            Step::ModelConfig => self.model_config().await,
            Step::AgentRuntime => self.agent_runtime().await,
        }
    }

    async fn data_folder(&self) -> Result<(), SetupStepError> {
        let probe = self.data_root.join(PROBE_FILE);
        let unwritable = |_| {
            failure(
                "data_folder_unwritable",
                "The data folder cannot be written.",
            )
        };
        if let Some(parent) = probe.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(unwritable)?;
        }
        tokio::fs::write(&probe, b"ok").await.map_err(unwritable)?;
        tokio::fs::remove_file(&probe).await.map_err(unwritable)
    }

    async fn model_config(&self) -> Result<(), SetupStepError> {
        self.configuration.read().await.map(|_| ()).map_err(|_| {
            failure(
                "model_config_unreadable",
                "The model configuration or saved keys cannot be read.",
            )
        })
    }

    async fn agent_runtime(&self) -> Result<(), SetupStepError> {
        let deadline = tokio::time::Instant::now() + EXECUTOR_WAIT;
        loop {
            match self.executor.published_identity() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(EXECUTOR_POLL).await;
                }
                Ok(None) => {
                    return Err(failure(
                        "agent_runtime_not_ready",
                        "The turn executor did not become ready.",
                    ));
                }
                Err(_) => {
                    return Err(failure(
                        "agent_runtime_unreadable",
                        "The turn executor readiness cannot be read.",
                    ));
                }
            }
        }
    }
}

fn failure(code: &str, detail: &str) -> SetupStepError {
    SetupStepError {
        code: code.to_owned(),
        detail: detail.to_owned(),
    }
}
