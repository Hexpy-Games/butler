//! Durable Worker result delivery to the owning Steward queue.

use super::*;
use crate::btcc::storage::worker_result_turn_id;
use crate::btcc::{BtccCode, BtccError};
use crate::workspace::StoredSessionBinding;

/// One input that continues a Steward session in a new turn.
struct StewardInput<'a> {
    event_id: String,
    message_id: String,
    turn_id: String,
    text: &'a str,
    timestamp: &'a str,
    sender: Value,
    raw: Value,
}

impl SubsessionService {
    pub(crate) async fn deliver_worker_results(&self) -> Result<(), BtccError> {
        for pending in self
            .repository
            .pending_parent_inputs()
            .await
            .map_err(BtccError::from)?
        {
            if pending.route != ParentResultRoute::StewardQueue {
                continue;
            }
            let parent = self
                .steward_binding(&pending.parent_session_id)
                .await?
                .ok_or_else(|| error(BtccCode::ParentStewardSessionRequired))?;
            let crate::btcc::ParentResultInput::StewardQueue(input) = &pending.input else {
                return Err(error(BtccCode::SubsessionOutboxInvalid));
            };
            self.enqueue_steward_input(
                parent,
                StewardInput {
                    event_id: format!("worker-result:{}", pending.result_id),
                    message_id: format!("worker-result-message:{}", pending.result_id),
                    turn_id: worker_result_turn_id(&pending.result_id),
                    text: &input.text,
                    timestamp: &input.timestamp,
                    sender: json!({"id":"butler-worker-result","displayName":"Worker"}),
                    raw: json!({"source":"btcc-worker-result","resultId":pending.result_id}),
                },
            )
            .await?;
            self.repository
                .mark_delivered(pending.result_id, (self.now)())
                .await
                .map_err(BtccError::from)?;
        }
        Ok(())
    }

    /// Continues each Steward whose latest turn waits for Workers that have
    /// all answered. Nothing ends such a wait, so the input that turn left
    /// unanswered comes again in a new turn of the same session.
    pub(crate) async fn wake_unwoken_waits(&self) -> Result<(), BtccError> {
        for wait in self
            .repository
            .unwoken_worker_waits()
            .await
            .map_err(BtccError::from)?
        {
            let Some(parent) = self.steward_binding(&wait.session_id).await? else {
                continue;
            };
            let now = (self.now)();
            self.enqueue_steward_input(
                parent,
                StewardInput {
                    event_id: format!("worker-wait-wake:{}", wait.turn_id),
                    message_id: format!("{}:wake", wait.original_message_id),
                    turn_id: format!(
                        "worker-wait-wake-turn-{}",
                        crate::btcc::digest_identity(&wait.turn_id)
                    ),
                    text: &wait.original_message,
                    timestamp: &now,
                    sender: json!({"id":"butler-worker-wait-wake","displayName":"Butler"}),
                    raw: json!({"source":"btcc-worker-wait-wake","waitTurnId":wait.turn_id}),
                },
            )
            .await?;
        }
        Ok(())
    }

    /// The session's binding when it is a Steward.
    async fn steward_binding(
        &self,
        session_id: &str,
    ) -> Result<Option<StoredSessionBinding>, BtccError> {
        Ok(self
            .bindings
            .get_by_session_id(session_id)
            .await
            .map_err(BtccError::from)?
            .filter(|binding| binding.role == SessionRole::Steward))
    }

    async fn enqueue_steward_input(
        &self,
        parent: StoredSessionBinding,
        input: StewardInput<'_>,
    ) -> Result<(), BtccError> {
        let delegation = self
            .repository
            .by_child(parent.session_id.clone())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        let reasoning_effort = parent
            .metadata
            .as_ref()
            .and_then(|value| value.get("reasoning_effort"))
            .and_then(Value::as_str)
            .ok_or_else(|| error(BtccCode::ParentStewardContextRequired))?;
        let mut raw = input.raw;
        raw["parentRelationId"] = json!(delegation.relation_id);
        let mut envelope = json!({"eventId":input.event_id,"transport":"app","accountId":"local","peer":{"kind":"dm","id":parent.session_id},"sender":input.sender,"message":{"id":input.message_id,"text":input.text,"timestamp":input.timestamp},"routingHints":{"sessionId":parent.session_id,"turnId":input.turn_id},"nativeStewardContext":{"version":1,"role":"steward","projectName":parent.project_id.unwrap_or_default(),"workspacePath":parent.workspace_path,"modelRef":parent.model_ref,"reasoningEffort":reasoning_effort},"raw":raw});
        // The steward of an unattended schedule run stays unattended (D8).
        if let (Some(run), Some(context)) = (
            &delegation.packet.schedule_run,
            envelope
                .get_mut("nativeStewardContext")
                .and_then(Value::as_object_mut),
        ) {
            context.insert("scheduleRun".into(), json!(run));
        }
        self.queue.enqueue(SubsessionEnqueue {
            envelope,
            metadata: serde_json::Map::new(),
        })
    }
}
