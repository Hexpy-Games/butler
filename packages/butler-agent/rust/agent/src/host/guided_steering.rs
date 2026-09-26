//! Same-Turn Work refresh before a model round.

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::btcc::{GuidedInvocation, PortFuture, SteeringObservation, TurnSteeringPort};

use super::guided_prompt::{GuidedTextState, work_context};

pub(crate) struct NativeGuidedSteering {
    state: Arc<GuidedTextState>,
    last_rendered: Mutex<Option<String>>,
    subsessions: Arc<crate::btcc::NativeSubsessionService>,
    child_session_id: String,
    child_turn_id: String,
}

impl NativeGuidedSteering {
    pub(crate) fn new(
        state: Arc<GuidedTextState>,
        subsessions: Arc<crate::btcc::NativeSubsessionService>,
        child_session_id: String,
        child_turn_id: String,
    ) -> Self {
        let last_rendered = work_context::render(state.work.context.as_ref());
        Self {
            state,
            last_rendered: Mutex::new(last_rendered),
            subsessions,
            child_session_id,
            child_turn_id,
        }
    }
}

impl TurnSteeringPort for NativeGuidedSteering {
    fn observe<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        Box::pin(async move {
            let direction = self
                .subsessions
                .consume_direction(&self.child_session_id, &self.child_turn_id)
                .await?;
            let current = if self.state.phase.execution_policy.tracking_mode == "none" {
                None
            } else {
                self.state
                    .work_service
                    .load_context(self.state.work_scope.clone())
                    .await?
            };
            let rendered = work_context::render(current.as_ref());
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
                observations.push(SteeringObservation {
                    content: format!("Parent direction update for this delegated Work.\nDirection revision: {}\nInstruction: {}\nContinue the same assigned Work from its retained checkpoint. Do not restart completed actions or create a replacement Work.", direction.revision, direction.instruction),
                    request_segment_kind: "subsession_parent_direction".into(),
                });
            }
            let _ = invocation;
            Ok(observations)
        })
    }
}
