use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use super::contracts::{StopPersistenceOutcome, TurnSemanticState};
use crate::btcc::BtccError;

#[derive(Clone, Default)]
pub(super) struct TurnExecutionSupervisor {
    inner: Arc<Mutex<SupervisorState>>,
}

#[derive(Default)]
struct SupervisorState {
    next_generation: u64,
    turns: HashMap<String, Registration>,
}

struct Registration {
    generation: u64,
    stop_attempt_generation: u64,
    permit_generation: Option<u64>,
    token: CancellationToken,
    fence: FenceState,
    durable_terminal: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FenceState {
    Open,
    Stopped,
    FinalizingOnly,
    PendingPersistence,
}

pub(super) struct ExecutionPermit {
    turn_id: String,
    registration_generation: u64,
    permit_generation: u64,
    token: CancellationToken,
    supervisor: TurnExecutionSupervisor,
}

pub(super) struct StopTicket {
    turn_id: String,
    registration_generation: u64,
    stop_attempt_generation: u64,
}

impl TurnExecutionSupervisor {
    pub(super) fn enter(
        &self,
        turn_id: &str,
        semantic_state: TurnSemanticState,
    ) -> Result<ExecutionPermit, BtccError> {
        let mut state = self.inner.lock().expect("supervisor lock poisoned");
        let permit_generation = next_generation(&mut state);
        let registration_generation = if let Some(registration) = state.turns.get_mut(turn_id) {
            let allowed = registration.fence == FenceState::Open
                || (registration.fence == FenceState::FinalizingOnly
                    && semantic_state == TurnSemanticState::DeliveryCommitted);
            if !allowed || registration.permit_generation.is_some() {
                return Err(BtccError::new("turn_fenced", "Turn execution is fenced"));
            }
            registration.permit_generation = Some(permit_generation);
            registration.generation
        } else {
            let generation = next_generation(&mut state);
            state.turns.insert(
                turn_id.to_owned(),
                Registration {
                    generation,
                    stop_attempt_generation: 0,
                    permit_generation: Some(permit_generation),
                    token: CancellationToken::new(),
                    fence: FenceState::Open,
                    durable_terminal: false,
                },
            );
            generation
        };
        let token = state.turns[turn_id].token.clone();
        Ok(ExecutionPermit {
            turn_id: turn_id.to_owned(),
            registration_generation,
            permit_generation,
            token,
            supervisor: self.clone(),
        })
    }

    /// Installs the process fence synchronously. Repository Stop must occur only
    /// after this method returns, so an active or queued Turn observes cancellation.
    pub(super) fn install_stop(&self, turn_id: &str) -> StopTicket {
        let mut state = self.inner.lock().expect("supervisor lock poisoned");
        let generation = next_generation(&mut state);
        let stop_attempt_generation = next_generation(&mut state);
        let registration = state
            .turns
            .entry(turn_id.to_owned())
            .or_insert_with(|| Registration {
                generation,
                stop_attempt_generation,
                permit_generation: None,
                token: CancellationToken::new(),
                fence: FenceState::Open,
                durable_terminal: false,
            });
        registration.fence = FenceState::Stopped;
        registration.stop_attempt_generation = stop_attempt_generation;
        registration.token.cancel();
        StopTicket {
            turn_id: turn_id.to_owned(),
            registration_generation: registration.generation,
            stop_attempt_generation,
        }
    }

    pub(super) fn observe_stop(&self, ticket: &StopTicket, outcome: StopPersistenceOutcome) {
        let mut state = self.inner.lock().expect("supervisor lock poisoned");
        let Some(registration) = state.turns.get_mut(&ticket.turn_id) else {
            return;
        };
        if registration.generation != ticket.registration_generation
            || registration.stop_attempt_generation != ticket.stop_attempt_generation
        {
            return;
        }
        match outcome {
            StopPersistenceOutcome::Cancelled | StopPersistenceOutcome::AlreadyCancelled => {
                registration.durable_terminal = true;
            }
            StopPersistenceOutcome::AlreadyDelivered(_) => {
                registration.durable_terminal = true;
            }
            StopPersistenceOutcome::AlreadyFinalizing => {
                registration.fence = FenceState::FinalizingOnly;
                registration.token = CancellationToken::new();
            }
        }
        if registration.durable_terminal && registration.permit_generation.is_none() {
            state.turns.remove(&ticket.turn_id);
        }
    }

    pub(super) fn observe_stop_failure(&self, ticket: &StopTicket) {
        let mut state = self.inner.lock().expect("supervisor lock poisoned");
        if let Some(registration) = state.turns.get_mut(&ticket.turn_id)
            && registration.generation == ticket.registration_generation
            && registration.stop_attempt_generation == ticket.stop_attempt_generation
        {
            registration.fence = FenceState::PendingPersistence;
        }
    }

    pub(super) fn observe_terminal(&self, turn_id: &str) {
        let mut state = self.inner.lock().expect("supervisor lock poisoned");
        if let Some(registration) = state.turns.get_mut(turn_id) {
            registration.durable_terminal = true;
            if registration.permit_generation.is_none() {
                state.turns.remove(turn_id);
            }
        }
    }

    fn close_permit(&self, turn_id: &str, registration_generation: u64, permit_generation: u64) {
        let mut state = self.inner.lock().expect("supervisor lock poisoned");
        let mut retire = false;
        if let Some(registration) = state.turns.get_mut(turn_id)
            && registration.generation == registration_generation
            && registration.permit_generation == Some(permit_generation)
        {
            registration.permit_generation = None;
            retire = registration.fence == FenceState::Open || registration.durable_terminal;
        }
        if retire {
            state.turns.remove(turn_id);
        }
    }

    #[cfg(test)]
    pub(super) fn registration_count(&self) -> usize {
        self.inner
            .lock()
            .expect("supervisor lock poisoned")
            .turns
            .len()
    }
}

impl ExecutionPermit {
    pub(super) fn cancellation(&self) -> CancellationToken {
        self.token.clone()
    }

    pub(super) fn assert_active(&self) -> Result<(), BtccError> {
        if self.token.is_cancelled() {
            Err(BtccError::new(
                "turn_cancelled",
                "Turn execution was cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

impl Drop for ExecutionPermit {
    fn drop(&mut self) {
        self.supervisor.close_permit(
            &self.turn_id,
            self.registration_generation,
            self.permit_generation,
        );
    }
}

fn next_generation(state: &mut SupervisorState) -> u64 {
    state.next_generation = state.next_generation.wrapping_add(1).max(1);
    state.next_generation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_fence_blocks_reentry_until_persistence_outcome_allows_it() {
        let supervisor = TurnExecutionSupervisor::default();
        let permit = supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .unwrap();
        drop(permit);
        assert_eq!(
            supervisor.registration_count(),
            0,
            "ordinary permit retires"
        );

        // A stop cancels the running permit; a failed stop keeps the fence.
        let permit = supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .unwrap();
        let ticket = supervisor.install_stop("turn-1");
        assert!(permit.cancellation().is_cancelled());
        supervisor.observe_stop_failure(&ticket);
        drop(permit);
        assert!(
            supervisor
                .enter("turn-1", TurnSemanticState::Admitted)
                .is_err()
        );

        // A turn already finalizing may still deliver, then retires.
        let supervisor = TurnExecutionSupervisor::default();
        let ticket = supervisor.install_stop("turn-1");
        supervisor.observe_stop(&ticket, StopPersistenceOutcome::AlreadyFinalizing);
        assert!(
            supervisor
                .enter("turn-1", TurnSemanticState::Admitted)
                .is_err()
        );
        let permit = supervisor
            .enter("turn-1", TurnSemanticState::DeliveryCommitted)
            .unwrap();
        supervisor.observe_terminal("turn-1");
        drop(permit);
        assert_eq!(supervisor.registration_count(), 0);
    }

    #[test]
    fn stale_stop_results_cannot_change_newer_registrations_or_fences() {
        let supervisor = TurnExecutionSupervisor::default();
        let ticket = supervisor.install_stop("turn-1");
        supervisor.observe_stop(&ticket, StopPersistenceOutcome::AlreadyCancelled);
        let permit = supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .unwrap();
        supervisor.observe_stop_failure(&ticket);
        drop(permit);
        assert_eq!(supervisor.registration_count(), 0);

        let supervisor = TurnExecutionSupervisor::default();
        let older = supervisor.install_stop("turn-1");
        let newer = supervisor.install_stop("turn-1");
        supervisor.observe_stop_failure(&newer);
        supervisor.observe_stop(&older, StopPersistenceOutcome::AlreadyFinalizing);
        assert!(
            supervisor
                .enter("turn-1", TurnSemanticState::DeliveryCommitted)
                .is_err()
        );
    }
}
