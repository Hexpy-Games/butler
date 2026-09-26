use std::future::Future;

use serde_json::Value;

use crate::btcc::{
    BtccError, ModelRoundAcceptanceWrite, ModelRoundKey, ModelRouteEventWrite, ModelRouteWrite,
    StateExecutionClaim, TurnRecord, TurnStore,
};

use super::failure;

#[derive(Clone)]
pub(super) struct RouteHooks {
    store: std::sync::Arc<dyn TurnStore>,
    binding: ModelRouteWrite,
    route_digest: String,
    checkpoint_id: String,
    checkpoint_revision: u64,
}

impl RouteHooks {
    pub(super) fn new(
        store: std::sync::Arc<dyn TurnStore>,
        turn: &TurnRecord,
        claim: &StateExecutionClaim,
        route: Value,
        route_digest: String,
    ) -> Self {
        Self {
            store,
            binding: ModelRouteWrite {
                turn_id: turn.turn_id.clone(),
                expected_revision: turn.revision,
                execution_fence: turn.execution_fence,
                claim_id: claim.claim_id.clone(),
                route,
            },
            route_digest,
            checkpoint_id: claim.checkpoint_id.clone(),
            checkpoint_revision: claim.checkpoint_revision,
        }
    }

    pub(super) async fn event(
        &self,
        event: Value,
        route: Option<Value>,
    ) -> Result<Option<Value>, crate::btcc::agent_loop::ModelRoundError> {
        let mut binding = self.binding.clone();
        if let Some(route) = route {
            binding.route = route;
        }
        self.retry("attempt_event_write", || {
            self.store.record_model_route_event(ModelRouteEventWrite {
                binding: binding.clone(),
                event: event.clone(),
            })
        })
        .await
    }

    pub(super) async fn history(
        &self,
        round: &str,
        candidate: u32,
        model: &str,
    ) -> Result<Value, crate::btcc::agent_loop::ModelRoundError> {
        let key = self.key(round, candidate, model, false);
        self.retry("attempt_history_read", || {
            self.store.load_model_route_attempt_history(key.clone())
        })
        .await
    }

    pub(super) async fn accepted(
        &self,
        round: &str,
        candidate: u32,
        model: &str,
    ) -> Result<Option<Value>, crate::btcc::agent_loop::ModelRoundError> {
        let key = self.key(round, candidate, model, true);
        self.retry("response_acceptance_read", || {
            self.store.load_model_round_acceptance(key.clone())
        })
        .await
    }

    pub(super) async fn accept(
        &self,
        round: &str,
        candidate: u32,
        attempt: u32,
        model: &str,
        result: Value,
    ) -> Result<(), crate::btcc::agent_loop::ModelRoundError> {
        let write = ModelRoundAcceptanceWrite {
            binding: self.binding.clone(),
            key: self.key(round, candidate, model, true),
            transport_attempt: attempt,
            result,
        };
        self.retry("response_acceptance_write", || {
            self.store.record_model_round_acceptance(write.clone())
        })
        .await
    }

    fn key(&self, round: &str, candidate: u32, model: &str, checkpoint: bool) -> ModelRoundKey {
        ModelRoundKey {
            turn_id: self.binding.turn_id.clone(),
            round_id: round.into(),
            route_digest: self.route_digest.clone(),
            candidate_index: candidate,
            model_ref: model.into(),
            checkpoint_id: checkpoint.then(|| self.checkpoint_id.clone()),
            checkpoint_revision: checkpoint.then_some(self.checkpoint_revision),
        }
    }

    async fn retry<T, F, Fut>(
        &self,
        phase: &str,
        mut operation: F,
    ) -> Result<T, crate::btcc::agent_loop::ModelRoundError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, BtccError>>,
    {
        for attempt in 1..=3 {
            match operation().await {
                Ok(value) => return Ok(value),
                Err(error) if contention(&error) && attempt < 3 => tokio::task::yield_now().await,
                Err(error) => return Err(failure::durability(phase, error)),
            }
        }
        unreachable!()
    }
}

fn contention(error: &BtccError) -> bool {
    error.code == "sqlite_contention"
        || error.message.contains("database is locked")
        || error.message.contains("database is busy")
}
