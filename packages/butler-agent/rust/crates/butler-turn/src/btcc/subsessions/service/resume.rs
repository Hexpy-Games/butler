use super::*;
use crate::btcc::StoredSubsessionDelegation;
use crate::workspace::SessionRole;

impl SubsessionService {
    /// Resumes a subsession.
    pub async fn resume(&self, request: SubsessionResumeRequest) -> Result<Value, BtccError> {
        let relation = self
            .repository
            .relation_by_id(request.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .filter(|relation| {
                relation.parent_session_id == request.parent_session_id
                    && (self.work.work_model().is_some()
                        || relation.packet.child_role == crate::btcc::ChildRole::Steward)
            })
            .ok_or_else(|| error(BtccCode::StewardRelationNotFound))?;
        if self.work.work_model().is_some() {
            return self.resume_managed(&relation, &request).await;
        }
        let parent = self
            .bindings
            .get_by_session_id(&request.parent_session_id)
            .await
            .map_err(BtccError::from)?
            .filter(|binding| binding.role == SessionRole::Butler)
            .ok_or_else(|| error(BtccCode::StewardRelationNotFound))?;
        let _ = parent;
        if self
            .repository
            .open_relation_by_work(relation.root_work_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_none()
        {
            return Err(error(BtccCode::StewardRelationNotActive));
        }
        let turn = self
            .repository
            .latest_resume_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?
            .filter(|turn| turn.semantic_state == "admitted")
            .ok_or_else(|| error(BtccCode::StewardRelationNotActive))?;
        let interrupted = self
            .queue
            .interrupted_event(
                &turn.original_event_id,
                &relation.child_session_id,
                &turn.turn_id,
            )?
            .filter(|event| {
                event.event_id == turn.original_event_id
                    && event.message_id == turn.original_message_id
                    && event.message == turn.original_message
            })
            .ok_or_else(|| error(BtccCode::StewardRelationNotRecoverable))?;
        let request_id = format!(
            "app-steward-resume:{}:{}",
            relation.relation_id, interrupted.recovery_id
        );
        let now = (self.now)();
        self.queue.enqueue(super::SubsessionEnqueue {
            envelope: json!({
            "eventId":format!("app:resume:{request_id}"),"transport":"app","accountId":"local",
            "peer":{"kind":"dm","id":relation.child_session_id,"parentId":relation.parent_session_id},
            "sender":{"id":"app-user","displayName":"Butler App"},
            "message":{"id":interrupted.message_id,"text":interrupted.message,"timestamp":now},
            "routingHints":{"sessionId":relation.child_session_id,"turnId":turn.turn_id,"canonicalEventId":interrupted.event_id},
            "control":{"kind":"resume_turn","requestId":request_id,"turnId":turn.turn_id,"requestedAt":now},
            "raw":{"source":"app-steward-observer"}
            }),
            metadata: serde_json::Map::new(),
        })?;
        Ok(
            json!({"relation_id":relation.relation_id,"child_turn_id":turn.turn_id,
            "status":"resuming","request_id":request_id}),
        )
    }
    async fn resume_managed(
        &self,
        relation: &StoredSubsessionDelegation,
        request: &SubsessionResumeRequest,
    ) -> Result<Value, BtccError> {
        let (turn, _) = self
            .repository
            .latest_turn(request.parent_session_id.clone())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::StewardFollowupAuthorityMismatch))?;
        self.managed_lifecycle(
            relation,
            &request.parent_session_id,
            &turn,
            &format!("resume:{}:{turn}", request.relation_id),
            crate::btcc::work_model::WorkModelCommand::SessionResume,
        )
        .await
    }
}
