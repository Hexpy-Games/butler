//! Getting to a ready Agent (`ensureReady`, `ensureReadyOnce`, `start`, `adoptOwnedChild`):
//! attach to one that is ready, or spawn our child and wait up to 120 s for it.
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt as _;
use futures::channel::oneshot;
use serde_json::json;
use tokio::time::{Instant, sleep};

use super::attach::probe;
use super::launch::{self, OwnedChild};
use super::records::read_instance;
use super::state::{Inner, OwnedState, Phase, Startup, StartupFuture, State};
use super::{StopReason, SupervisorError};
use crate::lifecycle::logs;

/// `startupTimeoutMs`.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
/// `startupDelayMs`.
const STARTUP_STEP: Duration = Duration::from_millis(150);

/// What a startup that never saw the child ready reports: it answered health or it did not.
fn timeout_error(healthy: bool) -> SupervisorError {
    if healthy {
        SupervisorError::ReadinessTimeout
    } else {
        SupervisorError::HealthTimeout
    }
}

impl Inner {
    /// `ensureReady`. A restart that replaces the candidate mid-startup hands the caller its
    /// replacement instead of the startup failure.
    pub(super) async fn ensure_ready(self: &Rc<Self>) -> Result<(), SupervisorError> {
        if self.read_only {
            return Err(SupervisorError::LegacyDataBlocked);
        }
        loop {
            let generation = self.read(|state| state.restart_generation);
            let failure = match self.shared_startup().await {
                Ok(()) => return Ok(()),
                Err(Startup::Replaced) => continue,
                Err(failure) => failure,
            };
            let replaced =
                self.read(|state| state.restart_generation != generation && state.restarting());
            if !replaced {
                return Err(match failure {
                    Startup::Failed(error) => error,
                    _ => SupervisorError::EarlyExit,
                });
            }
        }
    }

    /// One startup at a time; every caller joins it.
    fn shared_startup(self: &Rc<Self>) -> StartupFuture {
        if let Some(running) = self.read(|state| state.startup.clone()) {
            return running;
        }
        let this = self.clone();
        let startup = async move {
            let result = this.ensure_ready_once().await;
            this.mutate(|state| state.startup = None);
            result
        }
        .boxed_local()
        .shared();
        self.mutate(|state| state.startup = Some(startup.clone()));
        startup
    }

    async fn ensure_ready_once(self: &Rc<Self>) -> Result<(), Startup> {
        self.reconcile_attached_exit();
        if self.quitting() {
            return Err(Startup::Failed(SupervisorError::ShuttingDown));
        }
        if let Some(error) = self.read(State::halt_error) {
            return Err(Startup::Failed(error));
        }
        if let Some(wait) = self.read(|state| state.restart_wait.clone()) {
            return wait.await.map_err(Startup::Failed);
        }
        if let Some(pid) = self.read(State::child_pid) {
            return self.wait_ready(pid).await;
        }
        let seen = probe(&self.data, None).await;
        if let (true, Some((pid, nonce))) = (seen.ready, seen.identity) {
            self.mark_attached(pid, nonce);
            return Ok(());
        }
        self.start().await
    }

    /// `start`: resolve the command, spawn the child holding the lease, wait for it.
    async fn start(self: &Rc<Self>) -> Result<(), Startup> {
        let command = match launch::resolve(&self.data) {
            Ok(command) => command,
            Err(error) => {
                self.record_error(error);
                return Err(Startup::Failed(error));
            }
        };
        let port = launch::pick_port();
        self.update(|state| {
            state.phase = Phase::Starting;
            state.command = Some(command.clone());
            state.port = Some(port);
            state.last_error = None;
            state.last_exit = None;
            // Only a stop of the child spawned next can replace this startup.
            state.last_stop = None;
            state.attached = None;
        });
        let Ok(child) = OwnedChild::spawn(&command, port) else {
            self.record_error(SupervisorError::SpawnFailed);
            return Err(Startup::Failed(SupervisorError::SpawnFailed));
        };
        let pid = child.pid();
        logs::app_log("INFO", "lifecycle", "agent.spawn", json!({ "pid": pid }));
        self.install_child(child);
        self.wait_ready(pid).await
    }

    /// Hands the child to a task that reports its exit, and keeps its lease and a kill request.
    fn install_child(self: &Rc<Self>, mut child: OwnedChild) {
        let pid = child.pid();
        let lease = child.lease_handle();
        let (kill, kill_requested) = oneshot::channel::<()>();
        if let Ok(mut slot) = self.lease_slot.lock() {
            *slot = Some(lease.clone());
        }
        self.mutate(|state| {
            state.child = Some(OwnedState {
                pid,
                lease,
                kill: Some(kill),
                nonce: None,
            });
        });
        let this = self.clone();
        tokio::task::spawn_local(async move {
            let kill = async {
                if kill_requested.await.is_err() {
                    std::future::pending::<()>().await;
                }
            };
            let status = tokio::select! {
                status = child.exited() => status,
                () = kill => {
                    child.kill_tree();
                    child.exited().await
                }
            };
            this.on_child_exit(pid, status);
        });
    }

    /// `adoptOwnedChild`: probe every 150 ms until our child (the instance record names its pid)
    /// is healthy and ready, it exits, or 120 s pass. At the deadline a child whose own record
    /// says ready is kept: the notice shows and probing goes on (this App may be the one that
    /// cannot connect); any other child is stopped.
    pub(super) async fn wait_ready(self: &Rc<Self>, pid: u32) -> Result<(), Startup> {
        let mut deadline = Some(Instant::now() + STARTUP_TIMEOUT);
        let mut healthy = false;
        loop {
            self.check_candidate(pid)?;
            self.remember_instance(pid);
            let seen = probe(&self.data, Some(pid)).await;
            healthy |= seen.healthy;
            self.check_candidate(pid)?;
            self.remember_instance(pid);
            if seen.ready {
                self.update(|state| {
                    state.phase = Phase::Running;
                    state.last_error = None;
                    state.respawning = false;
                });
                return Ok(());
            }
            let left = deadline.map(|at| at.saturating_duration_since(Instant::now()));
            let step = match left {
                Some(left) if left.is_zero() => {
                    let ready = read_instance(&self.data)
                        .is_some_and(|record| record.pid == pid && record.state == "ready");
                    if !ready {
                        break;
                    }
                    logs::app_log(
                        "INFO",
                        "lifecycle",
                        "agent.readiness_late",
                        json!({ "pid": pid }),
                    );
                    self.update(|state| state.last_error = Some(timeout_error(healthy)));
                    deadline = None;
                    STARTUP_STEP
                }
                Some(left) => STARTUP_STEP.min(left),
                None => STARTUP_STEP,
            };
            sleep(step).await;
        }
        let _ = self.stop(StopReason::Stop).await;
        let error = timeout_error(healthy);
        self.record_error(error);
        Err(Startup::Failed(error))
    }

    /// `throwIfCandidateFailed`: our child must still be the one we are waiting for.
    fn check_candidate(&self, pid: u32) -> Result<(), Startup> {
        let (alive, stopped, replaced, restarting) = self.read(|state| {
            (
                state.child_pid() == Some(pid),
                state
                    .halt
                    .as_ref()
                    .is_some_and(|h| h.reason == super::state::HaltReason::Stop),
                state.last_stop == Some(StopReason::Restart),
                state.restarting(),
            )
        });
        if alive {
            return Ok(());
        }
        if stopped {
            return Err(Startup::Failed(SupervisorError::Stopped));
        }
        if replaced {
            return Err(Startup::Replaced);
        }
        if restarting {
            return Err(Startup::Restarting);
        }
        if self.quitting() {
            return Err(Startup::Failed(SupervisorError::ShuttingDown));
        }
        self.record_error(SupervisorError::EarlyExit);
        Err(Startup::Failed(SupervisorError::EarlyExit))
    }

    /// `rememberChildInstance`: the nonce of our child, once its record shows its pid.
    fn remember_instance(&self, pid: u32) {
        if self.read(|state| state.child.as_ref().is_none_or(|c| c.nonce.is_some())) {
            return;
        }
        if let Some(nonce) = self.instance_for_pid(pid) {
            self.mutate(|state| {
                if let Some(child) = state.child.as_mut().filter(|c| c.pid == pid) {
                    child.nonce = Some(nonce);
                }
            });
        }
    }
}
