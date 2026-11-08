//! Getting Butler ready (`useSetupReadiness`, `app/setupReadiness.ts`, `FirstRunPrepStatus`):
//! the setup check, the readiness poll and the status line with its failure menu.
mod copy;
mod decode;
mod report;
mod status;

use std::time::Duration;

use butler_shell_client::Error;
use gpui::{Context, SharedString};
use serde_json::{Value, json};

pub(crate) use status::{prep_status, preparation_line};

use crate::lifecycle::setup::{self, SetupMode};
use crate::ui::settings::state::{fetch, fetch_if};

/// `READINESS_POLL_MS`: how often the Agent's readiness is re-read while it prepares.
const POLL: Duration = Duration::from_millis(800);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ReadinessStatus {
    #[default]
    Preparing,
    Ready,
    Failed,
}

/// The memory model download (`memory_model`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct MemoryModel {
    pub(crate) state: SharedString,
    pub(crate) bytes_done: u64,
    pub(crate) bytes_total: u64,
    pub(crate) reason: Option<SharedString>,
}

/// The readiness the screens show.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ReadinessView {
    pub(crate) status: ReadinessStatus,
    /// (id, status) per step; the status is `pending`, `running`, `done` or `failed`.
    pub(crate) steps: Vec<(SharedString, SharedString)>,
    pub(crate) done: usize,
    pub(crate) total: usize,
    /// The first failed step's code (`readinessFailureCode`).
    pub(crate) error_code: Option<SharedString>,
    pub(crate) memory_model: Option<MemoryModel>,
}

/// `LocalPreparation`: the App's own check (`POST /setup/start`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Local {
    Checking,
    Ready,
    Failed(SharedString),
}

/// The Agent's own answer: not read yet, a build without the route, or a view.
enum Agent {
    Waiting,
    Unsupported,
    View(ReadinessView),
}

/// Starts the setup check and polls readiness (800 ms; re-renders only on a change).
pub(crate) struct Readiness {
    view: ReadinessView,
    local: Local,
    agent: Agent,
    /// A new check or repair starts a new attempt; answers of an older one are dropped.
    attempt: u64,
    polling: bool,
}

/// `combineReadiness`: the local check decides first, then the Agent's view.
fn combine(local: &Local, agent: &Agent) -> ReadinessView {
    match (local, agent) {
        (Local::Failed(code), _) => ReadinessView {
            status: ReadinessStatus::Failed,
            steps: vec![("agent_service".into(), "failed".into())],
            total: 1,
            error_code: Some(code.clone()),
            ..ReadinessView::default()
        },
        (Local::Checking, Agent::View(view)) => ReadinessView {
            steps: view.steps.clone(),
            done: view.done,
            total: view.total,
            ..ReadinessView::default()
        },
        (Local::Ready, Agent::Unsupported) => ReadinessView {
            status: ReadinessStatus::Ready,
            ..ReadinessView::default()
        },
        (Local::Ready, Agent::View(view)) => view.clone(),
        _ => ReadinessView::default(),
    }
}

/// `memoryModelSettled`: chosen, and nothing more changes without the user.
fn memory_settled(model: Option<&MemoryModel>) -> bool {
    model.is_none_or(|model| matches!(&*model.state, "unset" | "off" | "ready" | "failed"))
}

impl Readiness {
    pub(crate) fn new(cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            view: ReadinessView::default(),
            local: Local::Checking,
            agent: Agent::Waiting,
            attempt: 0,
            polling: false,
        };
        this.check(SetupMode::Check, cx);
        this
    }

    pub(crate) fn view(&self) -> &ReadinessView {
        &self.view
    }

    /// "Try again": re-runs whichever part failed.
    pub(crate) fn retry(&mut self, cx: &mut Context<Self>) {
        let model_failed = matches!(
            &self.agent,
            Agent::View(view) if view.status == ReadinessStatus::Ready
                && view.memory_model.as_ref().is_some_and(|model| &*model.state == "failed")
        );
        if self.local == Local::Ready && model_failed {
            self.retry_agent(true, cx);
            return;
        }
        let failed = match &self.agent {
            Agent::View(view)
                if self.local == Local::Ready && view.status == ReadinessStatus::Failed =>
            {
                Some(view.clone())
            }
            _ => None,
        };
        match failed {
            Some(view) => {
                self.agent = Agent::View(ReadinessView {
                    steps: view.steps,
                    done: view.done,
                    total: view.total,
                    ..ReadinessView::default()
                });
                self.recompute(cx);
                self.retry_agent(false, cx);
            }
            None => self.check(SetupMode::Check, cx),
        }
    }

    /// "Reset and restart": the local check in repair mode.
    pub(crate) fn repair(&mut self, cx: &mut Context<Self>) {
        self.check(SetupMode::Repair, cx);
    }

    /// The memory choice's answer replaces the view.
    pub(crate) fn set(&mut self, view: ReadinessView, cx: &mut Context<Self>) {
        self.agent = Agent::View(view);
        self.recompute(cx);
        self.poll(cx);
    }

    /// `startFirstRunSetup(mode)`, then the readiness poll.
    fn check(&mut self, mode: SetupMode, cx: &mut Context<Self>) {
        self.attempt += 1;
        self.polling = false;
        self.local = Local::Checking;
        self.agent = Agent::Waiting;
        self.recompute(cx);
        let attempt = self.attempt;
        cx.spawn(async move |this, cx| {
            let status = setup::start(mode, cx).await;
            let _ = this.update(cx, move |this, cx| this.checked(attempt, &status, cx));
        })
        .detach();
    }

    fn checked(&mut self, attempt: u64, status: &Value, cx: &mut Context<Self>) {
        let phase = status.get("phase").and_then(Value::as_str);
        if self.attempt != attempt || phase == Some("cancelled") {
            return;
        }
        self.local = if phase == Some("ready") {
            Local::Ready
        } else {
            let code = status
                .get("error_code")
                .and_then(Value::as_str)
                .unwrap_or("setup_failed");
            Local::Failed(code.to_owned().into())
        };
        self.recompute(cx);
        self.poll(cx);
    }

    /// `retrySetupReadiness`: a failed retry runs the whole check again.
    fn retry_agent(&mut self, memory_model_only: bool, cx: &mut Context<Self>) {
        let attempt = self.attempt;
        let body = json!({ "memory_model_only": memory_model_only });
        fetch(
            cx,
            move |client| async move { client.retry_setup_readiness(&body).await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                if this.attempt != attempt {
                    return;
                }
                match result {
                    Ok(raw) => {
                        this.agent =
                            Agent::View(ReadinessView::from_value(&raw).unwrap_or_default());
                        this.recompute(cx);
                        this.poll(cx);
                    }
                    Err(_) => this.check(SetupMode::Check, cx),
                }
            },
        );
    }

    fn settled(&self) -> bool {
        match &self.agent {
            Agent::Unsupported => true,
            Agent::View(view) => {
                view.status != ReadinessStatus::Preparing
                    && memory_settled(view.memory_model.as_ref())
            }
            Agent::Waiting => false,
        }
    }

    /// Re-renders only when the combined view changed.
    fn recompute(&mut self, cx: &mut Context<Self>) {
        let next = combine(&self.local, &self.agent);
        if next != self.view {
            self.view = next;
            cx.notify();
        }
    }

    /// Reads the readiness once the local check passed, again every [`POLL`] until it settles.
    fn poll(&mut self, cx: &mut Context<Self>) {
        if self.polling || self.local != Local::Ready || self.settled() {
            return;
        }
        self.polling = true;
        let attempt = self.attempt;
        fetch_if(
            cx,
            |client| async move { client.get_setup_readiness().await },
            move |this: &mut Self, result: Result<Value, Error>, cx| {
                if this.attempt != attempt {
                    return false;
                }
                this.polling = false;
                match result {
                    Ok(raw) => {
                        this.agent =
                            Agent::View(ReadinessView::from_value(&raw).unwrap_or_default());
                    }
                    Err(Error::Http(404) | Error::Incompatible) => this.agent = Agent::Unsupported,
                    Err(_) => {}
                }
                this.recompute(cx);
                this.poll_later(attempt, cx);
                false
            },
        );
    }

    fn poll_later(&self, attempt: u64, cx: &mut Context<Self>) {
        if self.settled() {
            return;
        }
        cx.spawn(async move |this, cx| {
            butler_ds::ui::motion::sleep(cx.background_executor(), POLL).await;
            let _ = this.update(cx, |this, cx| {
                if this.attempt == attempt {
                    this.poll(cx);
                }
            });
        })
        .detach();
    }
}
