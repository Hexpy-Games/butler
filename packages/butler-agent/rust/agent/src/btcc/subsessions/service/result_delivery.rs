//! Durable Worker result delivery to the owning Steward queue.

use super::*;
use crate::btcc::BtccCode;
use crate::btcc::BtccError;

impl NativeSubsessionService {
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
            let timestamp = pending
                .input
                .get("timestamp")
                .and_then(Value::as_str)
                .ok_or_else(|| error(BtccCode::SubsessionOutboxInvalid))?;
            let text = pending
                .input
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| error(BtccCode::SubsessionOutboxInvalid))?;
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
            let envelope = json!({"eventId":format!("worker-result:{}",pending.result_id),"transport":"app","accountId":"local","peer":{"kind":"dm","id":pending.parent_session_id},"sender":{"id":"butler-worker-result","displayName":"Worker"},"message":{"id":format!("worker-result-message:{}",pending.result_id),"text":text,"timestamp":timestamp},"routingHints":{"sessionId":pending.parent_session_id,"turnId":turn_id},"nativeStewardContext":{"version":1,"role":"steward","projectName":parent.project_id.unwrap_or_default(),"workspacePath":parent.workspace_path,"modelRef":parent.model_ref,"reasoningEffort":reasoning_effort},"raw":{"source":"btcc-worker-result","resultId":pending.result_id,"parentRelationId":delegation.relation_id}});
            self.queue.enqueue(SubsessionEnqueue {
                envelope,
                metadata: serde_json::Map::new(),
            })?;
            self.repository
                .mark_delivered(pending.result_id, (self.now)())
                .await
                .map_err(BtccError::from)?;
        }
        Ok(())
    }
}
