//! One Turn's immutable budget binding; durable counters stay in TurnStore.

use std::sync::Arc;

use serde_json::Value;

use super::continuation_budget::{
    TurnContinuationBudgetEvent, TurnContinuationBudgetLimits, parse_turn_continuation_budget_state,
};
use super::{
    BtccError, ContinuationBudgetTransition, ModelRouteWrite, PortFuture, StateExecutionClaim,
    TurnRecord, TurnStore,
};
use crate::btcc::BtccCode;

pub(crate) trait TurnContinuationBudgetPort: Send + Sync {
    fn limits(&self) -> &TurnContinuationBudgetLimits;

    fn admit_request<'a>(
        &'a self,
        round_id: &'a str,
        request_digest: &'a str,
        model_facing_bytes: u64,
    ) -> PortFuture<'a, ()>;

    fn record_output<'a>(&'a self, round_id: &'a str, output_bytes: u64) -> PortFuture<'a, ()>;

    fn record_tool_round<'a>(&'a self, round_id: &'a str) -> PortFuture<'a, ()>;
}

pub(crate) struct GuidedContinuationBudgetFactory {
    store: Option<Arc<dyn TurnStore>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl GuidedContinuationBudgetFactory {
    pub(crate) fn new(
        store: Option<Arc<dyn TurnStore>>,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> Self {
        Self { store, clock }
    }

    pub(crate) fn bind(
        &self,
        turn: &TurnRecord,
        claim: &StateExecutionClaim,
    ) -> Result<Option<Arc<dyn TurnContinuationBudgetPort>>, BtccError> {
        let Some(value) = turn.continuation_budget.as_ref() else {
            return Ok(None);
        };
        let store = self.store.as_ref().ok_or_else(|| {
            BtccError::detected(
                BtccCode::TurnContinuationDependencyMissing,
                "turn_continuation_dependency_missing",
            )
        })?;
        let initial = parse_turn_continuation_budget_state(value.clone(), &turn.turn_id)?;
        Ok(Some(Arc::new(GuidedContinuationBudget {
            // No second mutable copy of request/output history is retained.
            limits: initial.limits,
            binding: ModelRouteWrite {
                turn_id: turn.turn_id.clone(),
                expected_revision: turn.revision,
                execution_fence: turn.execution_fence,
                claim_id: claim.claim_id.clone(),
                route: Value::Null,
            },
            store: store.clone(),
            clock: self.clock.clone(),
        })))
    }
}

struct GuidedContinuationBudget {
    limits: TurnContinuationBudgetLimits,
    binding: ModelRouteWrite,
    store: Arc<dyn TurnStore>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl GuidedContinuationBudget {
    async fn transition(&self, event: TurnContinuationBudgetEvent) -> Result<(), BtccError> {
        let event = serde_json::to_value(event).map_err(|error| {
            BtccError::detected(BtccCode::InvalidContinuationBudgetEvent, error.to_string())
                .with_source(error)
        })?;
        let now_ms = (self.clock)();
        self.store
            .transition_continuation_budget(ContinuationBudgetTransition {
                binding: self.binding.clone(),
                event,
                now_ms,
            })
            .await?;
        Ok(())
    }
}

impl TurnContinuationBudgetPort for GuidedContinuationBudget {
    fn limits(&self) -> &TurnContinuationBudgetLimits {
        &self.limits
    }

    fn admit_request<'a>(
        &'a self,
        round_id: &'a str,
        request_digest: &'a str,
        model_facing_bytes: u64,
    ) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.transition(TurnContinuationBudgetEvent::AdmitRequest {
                round_id: round_id.into(),
                request_digest: request_digest.into(),
                model_facing_bytes,
            })
            .await
        })
    }

    fn record_output<'a>(&'a self, round_id: &'a str, output_bytes: u64) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.transition(TurnContinuationBudgetEvent::RecordOutput {
                round_id: round_id.into(),
                output_bytes,
            })
            .await
        })
    }

    fn record_tool_round<'a>(&'a self, round_id: &'a str) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.transition(TurnContinuationBudgetEvent::RecordToolRound {
                round_id: round_id.into(),
            })
            .await
        })
    }
}
