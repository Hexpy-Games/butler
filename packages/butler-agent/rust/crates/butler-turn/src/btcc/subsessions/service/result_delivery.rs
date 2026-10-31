//! Durable Worker result delivery to the owning Steward queue.

use super::*;
use crate::btcc::storage::PendingParentInput;
use crate::btcc::{BtccCode, BtccError};

impl SubsessionService {
    /// Publish the execution change only after the durable outbox update.
    pub async fn mark_result_delivered(&self, result: String) -> Result<(), BtccError> {
        if let Some(link) = self
            .repository
            .mark_delivered(result, (self.now)())
            .await
            .map_err(BtccError::from)?
        {
            let _ = self.changes.send(link);
        }
        Ok(())
    }

    pub(crate) async fn deliver_worker_results(&self) -> Result<(), BtccError> {
        let mut failure = None;
        for pending in self
            .repository
            .pending_parent_inputs()
            .await
            .map_err(BtccError::from)?
        {
            if pending.route != ParentResultRoute::StewardQueue {
                continue;
            }
            if let Err(error) = self.deliver_worker_result(pending).await {
                butler_core::diagnostic!(
                    "[native-btcc] Worker result delivery failed code={}",
                    error.code()
                );
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn deliver_worker_result(&self, pending: PendingParentInput) -> Result<(), BtccError> {
        let parent = self
            .bindings
            .get_by_session_id(&pending.parent_session_id)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::ParentStewardSessionRequired))?;
        if parent.role != SessionRole::Steward {
            return Err(error(BtccCode::ParentStewardSessionRequired));
        }
        let delegation = self
            .repository
            .by_child(pending.parent_session_id.clone())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        // A Steward that already ended, such as a stopped one, has nothing left to continue.
        if self
            .repository
            .result_for_relation(delegation.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some()
        {
            return self.mark_result_delivered(pending.result_id).await;
        }
        let crate::btcc::ParentResultInput::StewardQueue(input) = &pending.input else {
            return Err(error(BtccCode::SubsessionOutboxInvalid));
        };
        let timestamp = &input.timestamp;
        let text = &input.text;
        let reasoning_effort = parent
            .metadata
            .as_ref()
            .and_then(|value| value.get("reasoning_effort"))
            .and_then(Value::as_str)
            .ok_or_else(|| error(BtccCode::ParentStewardContextRequired))?;
        let turn_id = format!(
            "worker-result-turn-{}",
            crate::btcc::digest_identity(&pending.result_id)
        );
        let mut envelope = json!({"eventId":format!("worker-result:{}",pending.result_id),"transport":"app","accountId":"local","peer":{"kind":"dm","id":pending.parent_session_id},"sender":{"id":"butler-worker-result","displayName":"Worker"},"message":{"id":format!("worker-result-message:{}",pending.result_id),"text":text,"timestamp":timestamp},"routingHints":{"sessionId":pending.parent_session_id,"turnId":turn_id},"nativeStewardContext":{"version":1,"role":"steward","projectName":parent.project_id.unwrap_or_default(),"workspacePath":parent.workspace_path,"modelRef":parent.model_ref,"reasoningEffort":reasoning_effort},"raw":{"source":"btcc-worker-result","resultId":pending.result_id,"parentRelationId":delegation.relation_id}});
        // The steward of an unattended schedule run stays unattended (D8).
        if let (Some(run), Some(context)) = (
            self.instruction_run_context(&pending.parent_session_id)
                .await?,
            envelope
                .get_mut("nativeStewardContext")
                .and_then(Value::as_object_mut),
        ) {
            context.insert("scheduleRun".into(), json!(run));
        }
        self.enqueue_child(SubsessionEnqueue {
            envelope,
            metadata: serde_json::Map::new(),
        })
        .await?;
        self.mark_result_delivered(pending.result_id).await
    }
}
