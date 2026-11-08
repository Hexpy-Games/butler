//! Stopping our child and the commands built on it (`stop`, `restart`, `resume`, `repair`).
//! Every App stop is the end of the lease (EOF on the child's stdin); a child that has not
//! exited after 8 s is killed. An attached Agent is only detached.
use std::rc::Rc;
use std::time::Duration;

use futures::channel::oneshot;
use tokio::time::timeout;

use super::records::{StopIntent, retract_intent, timestamp, write_intent};
use super::state::{Inner, Phase};
use super::{StopReason, SupervisorError};

/// `AGENT_STOP_KILL_TIMEOUT_MS`: the Agent drains and exits by itself at 6 s.
const KILL_AFTER: Duration = Duration::from_secs(8);
/// How long a delivered kill is given to show up as an exit.
const KILL_GRACE: Duration = Duration::from_secs(3);

impl Inner {
    /// `resume`: clears the halt, then ensures ready.
    pub(super) async fn resume(self: &Rc<Self>) -> Result<(), SupervisorError> {
        self.update(|state| {
            state.halt = None;
            state.last_error = None;
        });
        self.ensure_ready().await
    }

    /// `restart`: stop for a restart, wait, then ensure ready.
    pub(super) async fn restart(self: &Rc<Self>) -> Result<(), SupervisorError> {
        self.stop(StopReason::Restart).await?;
        self.update(|state| state.halt = None);
        self.ensure_ready().await
    }

    /// `repair`: like restart, forgetting the last error and exit first.
    pub(super) async fn repair(self: &Rc<Self>) -> Result<(), SupervisorError> {
        self.stop(StopReason::Restart).await?;
        self.update(|state| {
            state.halt = None;
            state.command = None;
            state.last_error = None;
            state.last_exit = None;
            state.phase = Phase::Idle;
        });
        self.ensure_ready().await
    }

    /// `stop({ wait: true })`: answers once our child has exited (kill included).
    pub(super) async fn stop(self: &Rc<Self>, reason: StopReason) -> Result<(), SupervisorError> {
        self.mutate(|state| {
            state.quitting |= reason == StopReason::Quit;
            // cancelRestartWait, cancelPollTick; an attached Agent is only detached.
            state.exit_generation += 1;
            state.restart_wait = None;
            state.poll_epoch += 1;
            state.poll_active = false;
            state.respawning = false;
            state.attached = None;
        });
        let running = self.read(|state| {
            state
                .child_pid()
                .map(|pid| (pid, state.phase == Phase::Stopping))
        });
        let Some((pid, already_stopping)) = running else {
            self.update(|state| state.phase = Phase::Stopped);
            return Ok(());
        };
        // Subscribe before delivering the stop: EOF can produce an immediate exit.
        let (exited_tx, mut exited) = oneshot::channel();
        self.mutate(|state| state.exit_waiters.push(exited_tx));
        let mut intent = None;
        if !already_stopping {
            self.update(|state| state.phase = Phase::Stopping);
            intent = self.write_stop_intent(pid, reason);
            if !self.release_lease() {
                self.retract(pid, intent.as_deref());
            }
        }
        if timeout(KILL_AFTER, &mut exited).await.is_err() {
            if !self.force_terminate(pid) {
                self.retract(pid, intent.as_deref());
            }
            let _ = timeout(KILL_GRACE, &mut exited).await;
        }
        self.update(|state| {
            if state.child.is_none() {
                state.phase = Phase::Stopped;
            }
        });
        Ok(())
    }

    /// `recordAppStopIntent`: skipped while the Agent has published no instance id, because no
    /// other supervisor can mistake that exit. Returns the instance id it named.
    fn write_stop_intent(&self, pid: u32, reason: StopReason) -> Option<String> {
        let known = self.read(|state| state.child.as_ref().and_then(|c| c.nonce.clone()));
        let nonce = known.or_else(|| self.instance_for_pid(pid))?;
        // A restart the App requests is one it respawns itself; a plain stop has no respawner.
        let restart = reason == StopReason::Restart;
        let intent = StopIntent {
            reason: if restart { "restart" } else { "stop" }.to_owned(),
            requested_by: "app".to_owned(),
            respawn_by: restart.then(|| "app".to_owned()),
            instance_id: nonce.clone(),
            pid,
            requested_at: timestamp(),
        };
        write_intent(&self.data, &intent).ok()?;
        Some(nonce)
    }

    fn retract(&self, pid: u32, instance_id: Option<&str>) {
        if let Some(instance_id) = instance_id {
            retract_intent(&self.data, pid, instance_id);
        }
    }

    /// Closes the child's stdin. False when there was nothing to close.
    fn release_lease(&self) -> bool {
        let lease = self.read(|state| state.child.as_ref().map(|child| child.lease.clone()));
        lease.is_some_and(|lease| lease.lock().is_ok_and(|mut stdin| stdin.take().is_some()))
    }

    /// The kill after the grace: the task that owns the child kills its process group, else the
    /// child alone. False when the request could not be delivered.
    fn force_terminate(&self, pid: u32) -> bool {
        let kill = self.mutate(|state| {
            state
                .child
                .as_mut()
                .filter(|child| child.pid == pid)
                .and_then(|child| child.kill.take())
        });
        kill.is_some_and(|kill| kill.send(()).is_ok())
    }
}
