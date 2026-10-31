//! Same-Turn Work refresh before a model round.

use std::sync::Arc;

use tokio::sync::Mutex;

use butler_turn::btcc::{
    GuidedInvocation, LoopPhase, PortFuture, SteeringObservation, TurnSteeringPort,
};

use crate::host::guided::prompt::{GuidedTextState, work_context};

pub(crate) struct GuidedSteering {
    state: Arc<GuidedTextState>,
    last_rendered: Mutex<Option<String>>,
    subsessions: Arc<butler_turn::btcc::SubsessionService>,
    child_session_id: String,
    child_turn_id: String,
}

impl GuidedSteering {
    pub(crate) fn new(
        state: Arc<GuidedTextState>,
        subsessions: Arc<butler_turn::btcc::SubsessionService>,
        child_session_id: String,
        child_turn_id: String,
    ) -> Self {
        let last_rendered =
            work_context::render(state.work.context.as_ref(), &state.work_scope.turn_id);
        Self {
            state,
            last_rendered: Mutex::new(last_rendered),
            subsessions,
            child_session_id,
            child_turn_id,
        }
    }
}

impl TurnSteeringPort for GuidedSteering {
    fn observe<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        phase: LoopPhase,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        Box::pin(async move {
            // A settled turn only reports, with its tools closed. Its direction
            // stays pending for the next turn, which can act on it.
            let direction = if phase == LoopPhase::FinalReport {
                None
            } else {
                self.subsessions
                    .consume_direction(&self.child_session_id, &self.child_turn_id)
                    .await?
            };
            let current = if self.state.phase.execution_policy.tracking_mode == "none" {
                None
            } else {
                self.state
                    .work_service
                    .load_context(self.state.work_scope.clone())
                    .await?
            };
            let rendered = work_context::render(current.as_ref(), &self.state.work_scope.turn_id);
            let mut last = self.last_rendered.lock().await;
            let mut observations = Vec::new();
            if *last != rendered {
                *last = rendered.clone();
                let content = match rendered {
                    Some(rendered) => {
                        format!("Updated current Work context for this same Work:\n{rendered}")
                    }
                    None => {
                        "Updated current Work context: no Work is currently bound to this Turn."
                            .into()
                    }
                };
                observations.push(SteeringObservation {
                    content,
                    request_segment_kind: "project_ledger_and_work_authority".into(),
                });
            }
            if let Some(direction) = direction {
                let unplanned = current
                    .as_ref()
                    .is_some_and(|context| context.work.current_plan.is_none());
                let next = if unplanned {
                    "This Work has no Plan yet: record one for this direction with replace_work_plan and review it. Any prior result is evidence, not new authority; do not restart completed actions."
                } else {
                    "Continue the same assigned Work from its retained checkpoint. Do not restart completed actions or create a replacement Work."
                };
                observations.push(SteeringObservation {
                    content: format!("Parent direction update for this delegated Work.\nDirection revision: {}\nInstruction: {}\n{next}", direction.revision, direction.instruction),
                    request_segment_kind: "subsession_parent_direction".into(),
                });
            }
            let _ = invocation;
            Ok(observations)
        })
    }
}
