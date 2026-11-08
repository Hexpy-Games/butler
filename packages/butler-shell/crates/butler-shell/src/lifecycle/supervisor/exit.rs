//! What an Agent exit means (`decideAgentExit`, `handleAgentExit`, `awaitReplacement`,
//! `main.mjs` `recoverUnexpectedForegroundExit`). The decision is made synchronously when the
//! exit is seen, before anything is awaited, so the next instance cannot clear the intent first.
use std::process::ExitStatus;
use std::rc::Rc;
use std::time::Duration;

use butler_platform::process_control::{ExitSignal, terminating_signal};
use futures::FutureExt as _;
use serde_json::json;
use tokio::time::{Instant, sleep};

use super::records::{StopIntent, read_instance, read_intent};
use super::state::{ExitInfo, Exited, Halt, HaltReason, Inner, Phase};
use super::{Requester, SupervisorError};
use crate::lifecycle::logs;

/// `AGENT_RESTART_RECONNECT_TIMEOUT_MS`.
const RECONNECT: Duration = Duration::from_secs(90);
/// `externalPollMs`.
const STEP: Duration = Duration::from_secs(1);

enum Decision {
    Recover,
    StayStopped(Option<Requester>),
    Respawn,
    AwaitRestart(Option<Requester>),
}

fn requester(intent: &StopIntent) -> Option<Requester> {
    match intent.requested_by.as_str() {
        "cli" => Some(Requester::Cli),
        "app" => Some(Requester::App),
        "mcp" => Some(Requester::Mcp),
        _ => None,
    }
}

/// The intent applies only when its instance and pid match the exited Agent; otherwise the exit
/// is a crash.
fn decide(intent: Option<&StopIntent>, exited: &Exited) -> Decision {
    let Some(intent) = intent else {
        return Decision::Recover;
    };
    let named = exited.nonce.as_deref() == Some(intent.instance_id.as_str());
    if !named || exited.pid == 0 || intent.pid != exited.pid {
        return Decision::Recover;
    }
    if intent.reason == "stop" {
        return Decision::StayStopped(requester(intent));
    }
    // Only the App that spawned the Agent can start it again with its own lease.
    if intent.respawn_by.as_deref() == Some("app") && exited.spawned_by_app {
        Decision::Respawn
    } else {
        Decision::AwaitRestart(requester(intent))
    }
}

impl Inner {
    /// Our child exited: record it, decide it unless the App asked for the stop, wake stoppers.
    pub(super) fn on_child_exit(self: &Rc<Self>, pid: u32, status: ExitStatus) {
        let known = self.read(|state| state.child.as_ref().and_then(|c| c.nonce.clone()));
        let nonce = known.or_else(|| self.instance_for_pid(pid));
        if let Ok(mut slot) = self.lease_slot.lock() {
            *slot = None;
        }
        let (code, signal) = (
            status.code(),
            terminating_signal(status).map(ExitSignal::name),
        );
        let level = if code == Some(0) { "INFO" } else { "ERROR" };
        logs::app_log(
            level,
            "lifecycle",
            "agent.exit",
            json!({ "code": code, "signal": signal }),
        );
        let (was_running, app_requested) = self.mutate(|state| {
            let seen = (
                state.phase == Phase::Running,
                state.phase == Phase::Stopping,
            );
            state.child = None;
            state.last_exit = Some(ExitInfo { code, signal });
            if state.phase != Phase::Stopping {
                state.phase = Phase::Stopped;
            }
            seen
        });
        if !app_requested {
            let exited = Exited {
                pid,
                nonce,
                spawned_by_app: true,
            };
            self.handle_agent_exit(exited, was_running);
        }
        self.publish();
        for waiter in self.mutate(|state| std::mem::take(&mut state.exit_waiters)) {
            let _ = waiter.send(());
        }
    }

    /// `handleAgentExit`. Changes state without pushing; the caller publishes.
    pub(super) fn handle_agent_exit(self: &Rc<Self>, exited: Exited, was_running: bool) {
        let intent = read_intent(&self.data);
        let decision = decide(intent.as_ref(), &exited);
        if matches!(decision, Decision::Respawn | Decision::AwaitRestart(_)) {
            let respawn_by = intent.and_then(|intent| intent.respawn_by);
            let attrs = json!({ "respawnBy": respawn_by, "phase": "requested" });
            logs::app_log("INFO", "lifecycle", "agent.restart", attrs);
        }
        let nonce = exited.nonce.clone();
        self.mutate(|state| state.last_exited = Some(exited));
        match decision {
            Decision::Recover => {
                if was_running {
                    let this = self.clone();
                    tokio::task::spawn_local(async move { this.recover().await });
                }
            }
            Decision::StayStopped(requested_by) => {
                self.mutate(|state| {
                    state.halt = Some(Halt {
                        reason: HaltReason::Stop,
                        requested_by,
                    });
                    state.phase = Phase::Stopped;
                });
                self.schedule_poll();
            }
            Decision::Respawn => {
                // The controller waits for this App to start the replacement; no budget is spent.
                let generation = self.mutate(|state| {
                    state.restart_generation += 1;
                    state.respawning = true;
                    state.restart_generation
                });
                let this = self.clone();
                tokio::task::spawn_local(async move {
                    if this.read(|s| s.respawning && s.restart_generation == generation) {
                        let _ = this.ensure_ready().await;
                    }
                });
            }
            Decision::AwaitRestart(requested_by) => {
                let generation = self.mutate(|state| {
                    state.restart_generation += 1;
                    state.exit_generation += 1;
                    state.exit_generation
                });
                let this = self.clone();
                let wait = async move {
                    this.await_replacement(nonce, requested_by, generation)
                        .await
                }
                .boxed_local()
                .shared();
                self.mutate(|state| state.restart_wait = Some(wait.clone()));
                tokio::task::spawn_local(async move {
                    let _ = wait.await;
                });
            }
        }
    }

    /// `recoverUnexpectedForegroundExit`: 3 recoveries per 60 s, then `Failed`.
    async fn recover(self: &Rc<Self>) {
        if self.read(|state| state.quitting) {
            return;
        }
        if !self.mutate(super::state::State::spend_budget) {
            self.update(|state| state.phase = Phase::Failed);
            return;
        }
        let attrs = json!({ "reason": "unexpected_exit", "phase": "requested" });
        logs::app_log("INFO", "lifecycle", "agent.restart", attrs);
        let _ = self.ensure_ready().await;
    }

    /// `awaitReplacement`: poll the instance record every second for 90 s for a different ready
    /// Agent; otherwise halt with `RestartTimeout`.
    async fn await_replacement(
        self: &Rc<Self>,
        exited_nonce: Option<String>,
        requested_by: Option<Requester>,
        generation: u64,
    ) -> Result<(), SupervisorError> {
        let deadline = Instant::now() + RECONNECT;
        let current = || self.read(|state| state.exit_generation == generation);
        while current() {
            if self.attach_replacement(exited_nonce.as_deref()).await {
                return Ok(());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            sleep(STEP.min(left)).await;
        }
        if !current() {
            return Ok(());
        }
        self.mutate(|state| {
            state.restart_wait = None;
            state.halt = Some(Halt {
                reason: HaltReason::RestartTimeout,
                requested_by,
            });
        });
        self.record_error(SupervisorError::RestartTimeout);
        self.schedule_poll();
        Err(SupervisorError::RestartTimeout)
    }

    /// The nonce of the instance record when it names `pid`.
    pub(super) fn instance_for_pid(&self, pid: u32) -> Option<String> {
        read_instance(&self.data)
            .filter(|record| record.pid == pid)
            .map(|record| record.nonce)
    }
}
