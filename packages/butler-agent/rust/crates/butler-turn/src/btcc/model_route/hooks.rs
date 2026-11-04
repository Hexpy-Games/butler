use crate::btcc::agent_loop::ModelRoundResult;
use crate::btcc::{
    AttemptHistory, ModelRoundAcceptanceWrite, ModelRoundKey, ModelRouteEvent,
    ModelRouteEventWrite, ModelRouteWrite, RouteEventStatus, RouteState, StateExecutionClaim,
    TurnRecord, TurnStore,
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
        route_digest: String,
    ) -> Self {
        Self {
            store,
            binding: ModelRouteWrite {
                turn_id: turn.turn_id.clone(),
                expected_revision: turn.revision,
                execution_fence: turn.execution_fence,
                claim_id: claim.claim_id.clone(),
                // Events persist a route only when they change it (fallback).
                route: None,
            },
            route_digest,
            checkpoint_id: claim.checkpoint_id.clone(),
            checkpoint_revision: claim.checkpoint_revision,
        }
    }

    pub(super) async fn event(
        &self,
        event: ModelRouteEvent,
        route: Option<RouteState>,
    ) -> Result<RouteEventStatus, crate::btcc::agent_loop::ModelRoundError> {
        let mut binding = self.binding.clone();
        if route.is_some() {
            binding.route = route;
        }
        self.store
            .record_model_route_event(ModelRouteEventWrite {
                binding: binding.clone(),
                event: event.clone(),
            })
            .await
            .map_err(|error| failure::durability("attempt_event_write", &error))
    }

    pub(super) async fn history(
        &self,
        round: &str,
        candidate: u32,
        model: &str,
    ) -> Result<AttemptHistory, crate::btcc::agent_loop::ModelRoundError> {
        let key = self.key(round, candidate, model, KeyScope::Route);
        self.store
            .load_model_route_attempt_history(key)
            .await
            .map_err(|error| failure::durability("attempt_history_read", &error))
    }

    pub(super) async fn accepted(
        &self,
        round: &str,
        candidate: u32,
        model: &str,
    ) -> Result<Option<ModelRoundResult>, crate::btcc::agent_loop::ModelRoundError> {
        let key = self.key(round, candidate, model, KeyScope::Checkpoint);
        self.store
            .load_model_round_acceptance(key)
            .await
            .map_err(|error| failure::durability("response_acceptance_read", &error))
    }

    pub(super) async fn accept(
        &self,
        round: &str,
        candidate: u32,
        attempt: u32,
        model: &str,
        result: ModelRoundResult,
    ) -> Result<(), crate::btcc::agent_loop::ModelRoundError> {
        let _timing = crate::btcc::agent_loop::command_timing::CommandTiming::new(
            "model_response_persistence",
        );
        let write = ModelRoundAcceptanceWrite {
            binding: self.binding.clone(),
            key: self.key(round, candidate, model, KeyScope::Checkpoint),
            transport_attempt: attempt,
            result: Box::new(result),
        };
        self.store
            .record_model_round_acceptance(write)
            .await
            .map_err(|error| failure::durability("response_acceptance_write", &error))
    }

    fn key(&self, round: &str, candidate: u32, model: &str, scope: KeyScope) -> ModelRoundKey {
        let checkpoint = scope == KeyScope::Checkpoint;
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
}

/// Whether a round key is bound to the claim's checkpoint (accepted
/// responses) or only to the route (attempt history).
#[derive(Clone, Copy, PartialEq, Eq)]
enum KeyScope {
    Route,
    Checkpoint,
}
