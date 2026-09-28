//! The agent's own background preparation (#230), reported by
//! `GET /setup/readiness` and the live event `setup.readiness_changed`.
//!
//! Steps, in order; the first failure stops the run with its reason:
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
}

impl Preparation {
    /// Starts the first run.
    pub(super) fn start(checks: ReadinessChecks) -> Self {
        let preparation = Self {
            checks: Arc::new(checks),
            state: watch::channel(initial_view()).0,
            run: Mutex::new(None),
        };
        preparation.begin();
        preparation
    }

    pub(super) fn subscribe(&self) -> watch::Receiver<SetupReadinessView> {
        self.state.subscribe()
    }

    /// Starts a new run unless one is still going; returns the view.
    pub(super) fn retry(&self) -> SetupReadinessView {
        if self.state.borrow().status != SetupReadinessStatus::Preparing {
            self.begin();
        }
        self.state.borrow().clone()
    }

    pub(super) async fn close(&self) {
        let run = self.run.lock().take();
        if let Some((stop, task)) = run {
            stop.cancel();
            let _ = task.await;
        }
    }

    fn begin(&self) {
        self.state.send_replace(initial_view());
        let stop = CancellationToken::new();
        let task = tokio::spawn(run(self.checks.clone(), self.state.clone(), stop.clone()));
        if let Some((previous, _)) = self.run.lock().replace((stop, task)) {
            previous.cancel();
        }
    }
}

impl Drop for Preparation {
    fn drop(&mut self) {
        if let Some((stop, _)) = self.run.get_mut().take() {
            stop.cancel();
        }
    }
}

fn initial_view() -> SetupReadinessView {
    SetupReadinessView {
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
        state.send_modify(|view| view.steps[index].status = SetupStepStatus::Running);
        let outcome = tokio::select! {
            outcome = checks.check(step) => outcome,
            () = stop.cancelled() => return,
        };
        state.send_modify(|view| {
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
        if state.borrow().status == SetupReadinessStatus::Failed {
            return;
        }
    }
    state.send_modify(|view| view.status = SetupReadinessStatus::Ready);
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
