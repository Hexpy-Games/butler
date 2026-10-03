//! Same-Turn Work refresh before a model round.

use std::sync::Arc;

use tokio::sync::Mutex;

use butler_turn::btcc::{GuidedInvocation, PortFuture, SteeringObservation, TurnSteeringPort};

use crate::host::guided::prompt::{GuidedTextState, work_context};

pub(crate) struct GuidedSteering {
    state: Arc<GuidedTextState>,
    last_rendered: Mutex<Option<String>>,
    subsessions: Arc<butler_turn::btcc::SubsessionService>,
    child_session_id: String,
    child_turn_id: String,
    delivered_seq: Mutex<u64>,
}

impl GuidedSteering {
    pub(crate) fn new(
        state: Arc<GuidedTextState>,
        subsessions: Arc<butler_turn::btcc::SubsessionService>,
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
            delivered_seq: Mutex::new(0),
        }
    }
    async fn instruction_observations(
        &self,
        model: &butler_turn::btcc::work_model::WorkModelService,
    ) -> Result<Vec<SteeringObservation>, butler_turn::btcc::BtccError> {
        let mut seq = self.delivered_seq.lock().await;
        let mut observations = Vec::new();
        loop {
            let deliveries = model
                .instruction_safe_point(
                    self.child_session_id.clone(),
                    self.child_turn_id.clone(),
                    *seq,
                )
                .await?;
            *seq = deliveries["last_seq"].as_u64().unwrap_or(*seq);
            observations.extend(deliveries["injections"].as_array().into_iter().flatten().map(|item| SteeringObservation {
                content:format!("Durable session instruction (receipt identifies the sender, immutable mode and boundary). Resolve its draft and acknowledge by instruction_id when applying operations. Never restart completed Tasks.\n{item}"),
                request_segment_kind:"current_user_request".into(),
            }));
            if deliveries["has_more"] != true {
                return Ok(observations);
            }
        }
    }
}

impl TurnSteeringPort for GuidedSteering {
    fn instruction_inbox(&self) -> bool {
        self.state.work_service.work_model().is_some()
    }
    fn seal<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
        final_answer: bool,
    ) -> PortFuture<'a, bool> {
        Box::pin(async move {
            let _ = invocation;
            if let Some(model) = self.state.work_service.work_model() {
                return model
                    .seal_instructions(
                        self.child_session_id.clone(),
                        self.child_turn_id.clone(),
                        *self.delivered_seq.lock().await,
                        final_answer,
                    )
                    .await;
            }
            Ok(true)
        })
    }
    fn observe<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, Vec<SteeringObservation>> {
        Box::pin(async move {
            if let Some(model) = self.state.work_service.work_model() {
                return self.instruction_observations(model).await;
            }
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
