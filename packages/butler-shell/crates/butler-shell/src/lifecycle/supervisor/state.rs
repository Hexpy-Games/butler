//! The supervisor thread's state: Electron's closure variables (`child`, `phase`, `attached`,
//! `halt`, `restartWait`, the generations) in one struct, behind a `RefCell` that is never held
//! across an await. Every change that moves the visible state goes through [`Inner::update`],
//! which pushes an [`AgentStatus`] only when it differs from the last one pushed.
use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::channel::{mpsc, oneshot};
use futures::future::{LocalBoxFuture, Shared};
use serde_json::{Value, json};
use tokio::process::ChildStdin;

use super::launch::{AgentCommand, AgentSource};
use super::{AgentState, AgentStatus, Requester, SupervisorError};

/// `AGENT_RECOVERY_BUDGET`: unexpected exits recovered per window.
const RECOVERY_MAX: usize = 3;
const RECOVERY_WINDOW: Duration = Duration::from_secs(60);

/// The child's stdin, which is the App's foreground lease.
pub(super) type Lease = Arc<Mutex<Option<ChildStdin>>>;
/// The current child's lease, shared with [`super::Supervisor::release_lease_now`].
pub(super) type LeaseSlot = Arc<Mutex<Option<Lease>>>;

/// `phase` of `app-agent-supervisor.mjs`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Idle,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum HaltReason {
    Stop,
    RestartTimeout,
}

/// An intentional external stop or a timed-out external restart; only an explicit start clears it.
pub(super) struct Halt {
    pub(super) reason: HaltReason,
    pub(super) requested_by: Option<Requester>,
}

/// Our child Agent.
pub(super) struct OwnedState {
    pub(super) pid: u32,
    pub(super) lease: Lease,
    /// Asks the task that owns the child to kill it (`Child::kill`).
    pub(super) kill: Option<oneshot::Sender<()>>,
    /// The instance nonce, once the instance record names the child's pid.
    pub(super) nonce: Option<String>,
}

/// A ready Agent this App did not spawn: watched, never signalled.
pub(super) struct Attached {
    pub(super) pid: u32,
    pub(super) nonce: String,
}

/// The identity of an Agent that just exited, as `decideAgentExit` needs it.
#[derive(Clone)]
pub(super) struct Exited {
    pub(super) pid: u32,
    pub(super) nonce: Option<String>,
    pub(super) spawned_by_app: bool,
}

pub(super) struct ExitInfo {
    pub(super) code: Option<i32>,
    pub(super) signal: Option<String>,
}

/// Why one startup attempt ended without a ready Agent.
#[derive(Clone, Copy)]
pub(super) enum Startup {
    Failed(SupervisorError),
    /// An intentional restart replaced the candidate; `ensure_ready` joins the replacement.
    Restarting,
}

pub(super) type StartupFuture = Shared<LocalBoxFuture<'static, Result<(), Startup>>>;
pub(super) type WaitFuture = Shared<LocalBoxFuture<'static, Result<(), SupervisorError>>>;

pub(super) struct State {
    pub(super) phase: Phase,
    pub(super) child: Option<OwnedState>,
    pub(super) command: Option<AgentCommand>,
    pub(super) port: Option<u16>,
    pub(super) last_error: Option<SupervisorError>,
    pub(super) last_exit: Option<ExitInfo>,
    pub(super) attached: Option<Attached>,
    pub(super) halt: Option<Halt>,
    pub(super) restart_wait: Option<WaitFuture>,
    pub(super) startup: Option<StartupFuture>,
    pub(super) exit_generation: u64,
    pub(super) restart_generation: u64,
    pub(super) respawning: bool,
    pub(super) quitting: bool,
    pub(super) last_exited: Option<Exited>,
    pub(super) poll_epoch: u64,
    pub(super) poll_active: bool,
    pub(super) exit_waiters: Vec<oneshot::Sender<()>>,
    budget: VecDeque<Instant>,
    published: AgentStatus,
}

impl State {
    fn new() -> Self {
        let mut state = Self {
            phase: Phase::Idle,
            child: None,
            command: None,
            port: None,
            last_error: None,
            last_exit: None,
            attached: None,
            halt: None,
            restart_wait: None,
            startup: None,
            exit_generation: 0,
            restart_generation: 0,
            respawning: false,
            quitting: false,
            last_exited: None,
            poll_epoch: 0,
            poll_active: false,
            exit_waiters: Vec::new(),
            budget: VecDeque::new(),
            published: AgentStatus {
                state: AgentState::Idle,
                requested_by: None,
                error: None,
                attached: false,
                pid: None,
            },
        };
        state.published = state.status();
        state
    }

    pub(super) fn child_pid(&self) -> Option<u32> {
        self.child.as_ref().map(|child| child.pid)
    }

    pub(super) fn restarting(&self) -> bool {
        self.respawning || self.restart_wait.is_some()
    }

    /// `haltError`.
    pub(super) fn halt_error(&self) -> Option<SupervisorError> {
        self.halt.as_ref().map(|halt| match halt.reason {
            HaltReason::Stop => SupervisorError::Stopped,
            HaltReason::RestartTimeout => SupervisorError::RestartTimeout,
        })
    }

    /// `agentState()`.
    fn agent_state(&self) -> AgentState {
        match self.halt.as_ref().map(|halt| halt.reason) {
            Some(HaltReason::Stop) => return AgentState::Stopped,
            Some(HaltReason::RestartTimeout) => return AgentState::RestartFailed,
            None => {}
        }
        if self.restarting() {
            return AgentState::Restarting;
        }
        match self.phase {
            Phase::Running => AgentState::Running,
            Phase::Starting => AgentState::Starting,
            Phase::Failed => AgentState::Failed,
            Phase::Idle | Phase::Stopping | Phase::Stopped => AgentState::Idle,
        }
    }

    fn status(&self) -> AgentStatus {
        AgentStatus {
            state: self.agent_state(),
            requested_by: self.halt.as_ref().and_then(|halt| halt.requested_by),
            error: self.last_error,
            attached: self.attached.is_some(),
            pid: self.child_pid().or(self.attached.as_ref().map(|a| a.pid)),
        }
    }

    /// `createRecoveryBudget().record()`: false once 3 recoveries ran in the last 60 s.
    pub(super) fn spend_budget(&mut self) -> bool {
        let now = Instant::now();
        while self
            .budget
            .front()
            .is_some_and(|at| now.duration_since(*at) >= RECOVERY_WINDOW)
        {
            self.budget.pop_front();
        }
        if self.budget.len() >= RECOVERY_MAX {
            return false;
        }
        self.budget.push_back(now);
        true
    }
}

/// What the supervisor thread's tasks share.
pub(super) struct Inner {
    pub(super) data: PathBuf,
    pub(super) read_only: bool,
    pub(super) lease_slot: LeaseSlot,
    status: mpsc::UnboundedSender<AgentStatus>,
    state: RefCell<State>,
}

impl Inner {
    pub(super) fn new(
        data: PathBuf,
        read_only: bool,
        status: mpsc::UnboundedSender<AgentStatus>,
        lease_slot: LeaseSlot,
    ) -> Self {
        Self {
            data,
            read_only,
            lease_slot,
            status,
            state: RefCell::new(State::new()),
        }
    }

    pub(super) fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.state.borrow())
    }

    /// Changes the state without pushing; the caller [`Self::publish`]es once its sync section
    /// is done, so a multi-step transition shows no intermediate state.
    pub(super) fn mutate<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        f(&mut self.state.borrow_mut())
    }

    pub(super) fn update<R>(&self, f: impl FnOnce(&mut State) -> R) -> R {
        let result = self.mutate(f);
        self.publish();
        result
    }

    /// Pushes the status when it differs from the last one pushed (polls change nothing).
    pub(super) fn publish(&self) {
        let next = {
            let mut state = self.state.borrow_mut();
            let next = state.status();
            if state.published == next {
                return;
            }
            state.published = next.clone();
            next
        };
        let _ = self.status.unbounded_send(next);
    }

    /// `recordError`.
    pub(super) fn record_error(&self, error: SupervisorError) {
        self.update(|state| {
            state.last_error = Some(error);
            state.phase = Phase::Failed;
            state.respawning = false;
        });
    }

    /// The `diagnostics()` view; credentials are booleans only.
    pub(super) fn diagnostics(&self) -> Value {
        let auth = self
            .data
            .join(butler_platform::data_paths::LOCAL_AUTH)
            .is_file();
        let state = self.state.borrow();
        let command = state.command.as_ref();
        let version = command.and_then(|c| c.version.clone());
        let source = match command.map(|c| c.source) {
            Some(AgentSource::Bundled | AgentSource::CliInstalled) => "app-managed",
            Some(AgentSource::Dev) | None => "development",
        };
        let error = state.last_error.map(
            |error| json!({ "code": error.code(), "details": {}, "raw_text_included": false }),
        );
        json!({
            "phase": state.phase.name(),
            "pid": state.child_pid(),
            "binding": { "host": "127.0.0.1", "port": state.port },
            "containment": {
                "kind": "direct_child",
                "verified": false,
                "owner_death_guaranteed": false,
                "raw_text_included": false,
            },
            "bundled_agent": {
                "source": source,
                "version_configured": version.is_some(),
                "version": version,
            },
            "local_auth": {
                "required": true,
                "file_configured": auth,
                "token_configured": auth,
                "raw_text_included": false,
            },
            "last_error_code": state.last_error.map(SupervisorError::code),
            "last_error": error,
            "last_exit": state
                .last_exit
                .as_ref()
                .map(|exit| json!({ "code": exit.code, "signal": exit.signal })),
            "agent_state": agent_state_name(state.agent_state()),
            "external_agent_attached": state.attached.is_some(),
            "raw_text_included": false,
        })
    }
}

/// `agentState().state` as Electron spells it.
fn agent_state_name(state: AgentState) -> &'static str {
    match state {
        AgentState::Running => "running",
        AgentState::Starting => "starting",
        AgentState::Stopped => "stopped",
        AgentState::Restarting => "restarting",
        AgentState::RestartFailed => "restart_failed",
        AgentState::Failed => "failed",
        AgentState::Idle => "idle",
    }
}
