//! Attaching to an Agent this App did not spawn: the readiness probe, replacement after an
//! external restart, and the 1 s liveness poll of an attached or halted Agent
//! (`attachReplacement`, `markAttached`, `reconcileAttachedExit`, `pollTick`). The poll decodes
//! files and processes only; it pushes a status when the state changed.
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

use butler_platform::process_control::{Liveness, liveness};
use butler_shell_client::{AttachState, ShellClient};
use serde_json::Value;
use tokio::time::{sleep, timeout};

use super::records::read_instance;
use super::state::{Attached, Exited, Inner, Phase};

/// `probeTimeoutMs`: each probe step is bounded.
const PROBE: Duration = Duration::from_secs(2);
/// `externalPollMs`.
const POLL: Duration = Duration::from_secs(1);

/// What one health and readiness probe saw.
pub(super) struct Probe {
    pub(super) healthy: bool,
    pub(super) ready: bool,
    /// The attached instance: its pid and nonce.
    pub(super) identity: Option<(u32, String)>,
}

/// `attach`, then `health()`, then `get_runtime_readiness()`, each bounded at 2 s. With
/// `want_pid` only an instance record naming that pid counts (our own child).
pub(super) async fn probe(data: &Path, want_pid: Option<u32>) -> Probe {
    let mut seen = Probe {
        healthy: false,
        ready: false,
        identity: None,
    };
    let Ok(Ok(AttachState::Connected(client))) =
        timeout(PROBE, ShellClient::attach(Some(data.to_path_buf()))).await
    else {
        return seen;
    };
    let (pid, nonce, _) = client.instance_identity();
    if want_pid.is_some_and(|want| want != *pid) {
        return seen;
    }
    seen.identity = Some((*pid, nonce.clone()));
    let Ok(Ok(health)) = timeout(PROBE, client.health()).await else {
        return seen;
    };
    seen.healthy = flag(&health, "ok");
    if !seen.healthy {
        return seen;
    }
    if let Ok(Ok(readiness)) = timeout(PROBE, client.get_runtime_readiness()).await {
        seen.ready = flag(&readiness, "authenticated_gateway_ready")
            && flag(&readiness, "btcc_executor_ready");
    }
    seen
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

/// `processIsAlive`: only a process that is gone counts as dead.
pub(super) fn alive(pid: u32) -> bool {
    pid > 0 && !matches!(liveness(pid), Liveness::Gone)
}

impl Inner {
    /// `attachReplacement`: a ready, enabled, different instance that is alive and passes the
    /// probe becomes the attached Agent.
    pub(super) async fn attach_replacement(self: &Rc<Self>, exited_nonce: Option<&str>) -> bool {
        let Some(record) = read_instance(&self.data) else {
            return false;
        };
        if record.state != "ready"
            || !record.app_enabled
            || record.port.is_none()
            || exited_nonce == Some(record.nonce.as_str())
            || !alive(record.pid)
            || self.read(|state| state.child.is_some())
        {
            return false;
        }
        let seen = probe(&self.data, Some(record.pid)).await;
        let named = seen
            .identity
            .is_some_and(|(_, nonce)| nonce == record.nonce);
        if !seen.ready || !named || self.read(|state| state.child.is_some()) {
            return false;
        }
        self.mark_attached(record.pid, record.nonce);
        true
    }

    /// `markAttached`: supervised (watched, reconnected), never owned.
    pub(super) fn mark_attached(self: &Rc<Self>, pid: u32, nonce: String) {
        self.update(|state| {
            state.attached = Some(Attached { pid, nonce });
            state.halt = None;
            state.respawning = false;
            state.restart_wait = None;
            state.phase = Phase::Running;
            state.last_error = None;
        });
        self.schedule_poll();
    }

    /// `reconcileAttachedExit`: the attached Agent is gone; decide its exit like a child's.
    pub(super) fn reconcile_attached_exit(self: &Rc<Self>) {
        let gone = self.mutate(|state| {
            if state.child.is_some() || state.attached.as_ref().is_none_or(|a| alive(a.pid)) {
                return None;
            }
            let attached = state.attached.take()?;
            state.phase = Phase::Stopped;
            Some(Exited {
                pid: attached.pid,
                nonce: Some(attached.nonce),
                spawned_by_app: false,
            })
        });
        if let Some(exited) = gone {
            self.handle_agent_exit(exited, true);
            self.publish();
        }
    }

    /// `schedulePollTick`: one poll loop at a time; stop() cancels it by bumping the epoch.
    pub(super) fn schedule_poll(self: &Rc<Self>) {
        let epoch = self.mutate(|state| {
            if state.poll_active {
                return None;
            }
            state.poll_active = true;
            Some(state.poll_epoch)
        });
        let Some(epoch) = epoch else {
            return;
        };
        let this = self.clone();
        tokio::task::spawn_local(async move {
            loop {
                sleep(POLL).await;
                if !this.poll_tick(epoch).await {
                    return;
                }
            }
        });
    }

    /// `pollTick`; false ends the loop.
    async fn poll_tick(self: &Rc<Self>, epoch: u64) -> bool {
        if self.read(|state| state.poll_epoch != epoch) {
            return false;
        }
        let (child, attached, waiting_for_replacement) = self.read(|state| {
            (
                state.child.is_some(),
                state.attached.is_some(),
                state.halt.is_some() && state.restart_wait.is_none(),
            )
        });
        if !child {
            if attached {
                self.reconcile_attached_exit();
            } else if waiting_for_replacement {
                let exited = self.read(|state| state.last_exited.clone());
                let nonce = exited.and_then(|exited| exited.nonce);
                self.attach_replacement(nonce.as_deref()).await;
            }
        }
        self.mutate(|state| {
            let keep = state.poll_epoch == epoch
                && state.child.is_none()
                && (state.attached.is_some() || state.halt.is_some());
            if !keep && state.poll_epoch == epoch {
                state.poll_active = false;
            }
            keep
        })
    }
}
