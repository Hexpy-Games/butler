//! Native bounded part assignment to a configured worker.
use super::*;
impl SubsessionService {
    pub async fn delegate_worker(
        &self,
        request: WorkerDelegationRequest,
    ) -> Result<Value, BtccError> {
        let parent = self
            .bindings
            .get_by_session_id(&request.parent_session_id)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionParentBindingMissing))?;
        // The assignment transaction checks the live Task/part lease. A chat
        // executing its own Task has the same authority as a child session.
        let profile = self.profiles.read(request.profile_id.clone()).await?;
        let input = admission::AssignmentRequest {
            parent_session_id: request.parent_session_id,
            parent_turn_id: request.parent_turn_id,
            anchor_message_id: request.anchor_message_id,
            request: request.objective,

            part_id: request.part_id,
            role: ChildRole::Worker,
            safe_title: request.safe_title,
            model_ref: profile.model_ref,
            reasoning_effort: profile.reasoning_effort,
            access_mode: request.access_mode,
            parent_chat_id: parent
                .transport_bindings
                .iter()
                .find(|binding| binding.transport == "app" && !binding.peer_id.trim().is_empty())
                .map(|binding| binding.peer_id.clone()),
            prior_context: None,
            implementation_brief: Some(request.implementation_brief),
            worker_prompt: profile.prompt,
            worker_profile: Some(crate::btcc::PacketWorkerProfile {
                id: profile.id,
                job: profile.job,
            }),
            schedule_run: request.schedule_run,
        };
        let stored = self.admit_assignment(input, parent).await?;
        self.worker_output(&stored).await
    }
}
