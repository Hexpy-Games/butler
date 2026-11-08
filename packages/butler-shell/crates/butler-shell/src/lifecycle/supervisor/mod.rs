//! The Agent supervisor (`app-agent-supervisor.mjs`, foreground path): attach to a ready Agent
//! or spawn our child holding the App's stdin lease, wait for readiness, decide exits from the
//! stop intent, and stop with end-of-lease then a kill. It runs on its own thread (a
//! current-thread runtime with a `LocalSet`, so its state is plain `Rc`/`RefCell`); the UI sends
//! commands and receives every state change as an [`AgentStatus`], and only a change.

mod attach;
mod exit;
pub(crate) mod launch;
pub(crate) mod records;
mod startup;
mod state;
mod stop;

use std::path::PathBuf;
use std::rc::Rc;

use futures::StreamExt as _;
use futures::channel::{mpsc, oneshot};
use serde_json::Value;

use super::Answer;
use state::{Inner, LeaseSlot};

/// `agentState().state`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum AgentState {
    Running,
    Starting,
    Stopped,
    Restarting,
    RestartFailed,
    Failed,
    #[default]
    Idle,
}

/// Who asked for a stop or restart (`requested_by` of the stop intent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Requester {
    Cli,
    App,
    Mcp,
}

/// Why the App stops its child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StopReason {
    Stop,
    Restart,
    Quit,
    FullReset,
    Update,
}

/// Why the Agent is not ready, with Electron's error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SupervisorError {
    LegacyDataBlocked,
    ShuttingDown,
    Stopped,
    RestartTimeout,
    /// No Agent to start; the code names what is missing.
    AgentUnavailable(&'static str),
    SpawnFailed,
    EarlyExit,
    HealthTimeout,
    ReadinessTimeout,
}

impl SupervisorError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::LegacyDataBlocked => "legacy_data_blocked",
            Self::ShuttingDown => "app_shutting_down",
            Self::Stopped => "agent_stopped",
            Self::RestartTimeout => "agent_restart_timeout",
            Self::AgentUnavailable(code) => code,
            Self::SpawnFailed => "spawn_failed",
            Self::EarlyExit => "early_exit",
            Self::HealthTimeout => "health_timeout",
            Self::ReadinessTimeout => "readiness_timeout",
        }
    }
}

/// One state change, pushed to [`super::AgentRuntime`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentStatus {
    pub(crate) state: AgentState,
    pub(crate) requested_by: Option<Requester>,
    pub(crate) error: Option<SupervisorError>,
    pub(crate) attached: bool,
    pub(crate) pid: Option<u32>,
}

type Reply = oneshot::Sender<Result<(), SupervisorError>>;

enum Command {
    EnsureReady(Reply),
    Resume(Reply),
    Restart(Reply),
    Repair(Reply),
    Stop(StopReason, Reply),
    Diagnostics(oneshot::Sender<Value>),
}

/// The UI's handle to the supervisor thread.
pub(crate) struct Supervisor {
    commands: mpsc::UnboundedSender<Command>,
    lease: LeaseSlot,
}

impl Supervisor {
    /// Starts the supervisor thread for `data`; `read_only` (a legacy folder) refuses every
    /// start.
    pub(crate) fn start(
        data: PathBuf,
        read_only: bool,
    ) -> (Self, mpsc::UnboundedReceiver<AgentStatus>) {
        let (status, statuses) = mpsc::unbounded();
        let (commands, incoming) = mpsc::unbounded();
        let lease = LeaseSlot::default();
        let slot = lease.clone();
        let _ = std::thread::Builder::new()
            .name("agent-supervisor".into())
            .spawn(move || run(Inner::new(data, read_only, status, slot), incoming));
        (Self { commands, lease }, statuses)
    }

    fn ask(&self, command: impl FnOnce(Reply) -> Command) -> Answer {
        let (reply, answer) = oneshot::channel();
        let _ = self.commands.unbounded_send(command(reply));
        answer
    }

    /// `ensureReady`: attach to a ready Agent or start our child and wait for it.
    pub(crate) fn ensure_ready(&self) -> Answer {
        self.ask(Command::EnsureReady)
    }

    /// Clears a stop halt, then [`Self::ensure_ready`] (the tray's Start, the notice's Start).
    pub(crate) fn resume(&self) -> Answer {
        self.ask(Command::Resume)
    }

    /// Stops our child for a restart, waits, then [`Self::ensure_ready`].
    pub(crate) fn restart(&self) -> Answer {
        self.ask(Command::Restart)
    }

    /// Like [`Self::restart`], forgetting the last error and exit first (setup repair).
    pub(crate) fn repair(&self) -> Answer {
        self.ask(Command::Repair)
    }

    /// Stops our child: the intent, end of the lease, a kill after 8 s. An attached Agent is
    /// only detached.
    pub(crate) fn stop(&self, reason: StopReason) -> Answer {
        self.ask(|reply| Command::Stop(reason, reply))
    }

    /// Drops the child's stdin now (the App is quitting without waiting).
    pub(crate) fn release_lease_now(&self) {
        let Ok(slot) = self.lease.lock() else {
            return;
        };
        if let Some(Ok(mut stdin)) = slot.as_ref().map(|lease| lease.lock()) {
            stdin.take();
        }
    }

    /// The `diagnostics()` view (phase, pid, binding, last error and exit; booleans only for
    /// credentials).
    pub(crate) fn diagnostics(&self) -> oneshot::Receiver<Value> {
        let (reply, answer) = oneshot::channel();
        let _ = self.commands.unbounded_send(Command::Diagnostics(reply));
        answer
    }
}

/// The supervisor thread: each command runs as its own local task, like Electron's async calls.
fn run(inner: Inner, mut incoming: mpsc::UnboundedReceiver<Command>) {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let inner = Rc::new(inner);
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async move {
        while let Some(command) = incoming.next().await {
            let inner = inner.clone();
            tokio::task::spawn_local(async move { inner.handle(command).await });
        }
    });
}

impl Inner {
    async fn handle(self: &Rc<Self>, command: Command) {
        match command {
            Command::EnsureReady(reply) => {
                let _ = reply.send(self.ensure_ready().await);
            }
            Command::Resume(reply) => {
                let _ = reply.send(self.resume().await);
            }
            Command::Restart(reply) => {
                let _ = reply.send(self.restart().await);
            }
            Command::Repair(reply) => {
                let _ = reply.send(self.repair().await);
            }
            Command::Stop(reason, reply) => {
                let _ = reply.send(self.stop(reason).await);
            }
            Command::Diagnostics(reply) => {
                let _ = reply.send(self.diagnostics());
            }
        }
    }
}
