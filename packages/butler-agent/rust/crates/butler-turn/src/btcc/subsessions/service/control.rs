//! Durable direction revisions and cancellation over the shared native queue.

use serde_json::{Value, json};

use super::{SubsessionService, error};
use crate::btcc::BtccCode;
use crate::btcc::{BtccError, StoredSubsessionDelegation, StoredSubsessionDirection};
use crate::workspace::SessionRole;

/// A parent's new direction for one of its subsessions.
#[derive(Clone, Debug)]
pub struct SubsessionDirectionRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub source_message_id: String,
    pub relation_id: Option<String>,
    pub work_id: Option<String>,
    pub safe_title: Option<String>,
    pub instruction: String,
    pub child_role: SessionRole,
    pub access_mode: String,
}

/// A parent's request to cancel one of its subsessions.
#[derive(Clone, Debug)]
pub struct SubsessionCancelRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub source_message_id: String,
    pub relation_id: Option<String>,
    pub safe_title: Option<String>,
    pub child_role: SessionRole,
}

/// A parent's request to resume a subsession.
#[derive(Clone, Debug)]
pub struct SubsessionResumeRequest {
    pub parent_session_id: String,
    pub relation_id: String,
}

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
                    && relation.packet.child_role == crate::btcc::ChildRole::Steward
            })
            .ok_or_else(|| error(BtccCode::StewardRelationNotFound))?;
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

    /// Sends new direction to a subsession.
    pub async fn steer(&self, request: SubsessionDirectionRequest) -> Result<Value, BtccError> {
        let instruction = butler_core::public_text::trim_js_whitespace(&request.instruction);
        if instruction.is_empty() {
            return Err(error(BtccCode::StewardDirectionInstructionRequired));
        }
        if instruction.chars().count() > 1_200 {
            return Err(error(BtccCode::StewardDirectionInstructionTooLong));
        }
        if request.access_mode == "read_only"
            || !self
                .repository
                .admitted_turn_matches(
                    request.parent_session_id.clone(),
                    request.parent_turn_id.clone(),
                    request.source_message_id.clone(),
                )
                .await
                .map_err(BtccError::from)?
        {
            return Err(error(BtccCode::StewardFollowupAuthorityMismatch));
        }
        let relation = self
            .select_relation(RelationQuery {
                parent: &request.parent_session_id,
                relation_id: request.relation_id.as_deref(),
                work_id: request.work_id.as_deref(),
                title: request.safe_title.as_deref(),
                role: &request.child_role,
                purpose: RelationPurpose::Direct,
            })
            .await?;
        let identity = json!({"relation_id":relation.relation_id,"source_message_id":request.source_message_id,"instruction":instruction});
        let instruction_id = format!(
            "steward-direction-{}",
            &crate::btcc::digest_identity(&identity.to_string())[..40]
        );
        let direction = self
            .repository
            .create_direction(
                relation.relation_id.clone(),
                request.parent_turn_id,
                request.source_message_id,
                instruction.into(),
                instruction_id.clone(),
                (self.now)(),
            )
            .await
            .map_err(BtccError::from)?;
        if direction.instruction_id != instruction_id || direction.instruction != instruction {
            return Err(error(BtccCode::StewardDirectionIdentityConflict));
        }
        let latest = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?;
        if latest.as_ref().is_none_or(|(_, state)| state != "admitted") {
            self.enqueue_direction(&relation, &direction).await?;
        }
        Ok(
            json!({"ok":true,"instruction_id":direction.instruction_id,"relation_id":relation.relation_id,"revision":direction.revision,"status":"pending"}),
        )
    }

    /// Cancels an unfinished subsession.
    pub async fn cancel(&self, request: SubsessionCancelRequest) -> Result<Value, BtccError> {
        let relation = self
            .select_relation(RelationQuery {
                parent: &request.parent_session_id,
                relation_id: request.relation_id.as_deref(),
                work_id: None,
                title: request.safe_title.as_deref(),
                role: &request.child_role,
                purpose: RelationPurpose::Cancel,
            })
            .await?;
        if self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some()
        {
            return Err(error(BtccCode::ActiveStewardRelationNotFound));
        }
        let turn_id = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?
            .map(|(id, _)| id)
            .unwrap_or_else(|| relation.child_turn_id.clone());
        let identity = json!({"relation_id":relation.relation_id,"source_message_id":request.source_message_id});
        let request_id = format!(
            "cancel-steward-{}",
            &crate::btcc::digest_identity(&identity.to_string())[..40]
        );
        let now = (self.now)();
        self.queue.enqueue(super::SubsessionEnqueue {
            envelope: json!({
            "eventId":format!("subsession-cancel:{request_id}"),"transport":"app","accountId":"local",
            "peer":{"kind":"dm","id":relation.child_session_id,"parentId":relation.parent_session_id},
            "sender":{"id":"subsession-parent-cancel","displayName":"Parent"},
            "message":{"id":format!("subsession-cancel-message:{request_id}"),"text":"","timestamp":now},
            "routingHints":{"sessionId":relation.child_session_id,"turnId":turn_id},
            "control":{"kind":"cancel_turn","requestId":request_id,"turnId":turn_id,"requestedAt":now}
            }),
            metadata: serde_json::Map::from_iter([
                ("source".into(), json!("btcc-steward-control")),
                ("relation_id".into(), json!(relation.relation_id)),
                (
                    "source_parent_turn_id".into(),
                    json!(request.parent_turn_id),
                ),
            ]),
        })?;
        Ok(
            json!({"relation_id":relation.relation_id,"child_turn_id":turn_id,"status":"cancelling","request_id":request_id}),
        )
    }

    /// Takes the next unconsumed direction for a child turn.
    pub async fn consume_direction(
        &self,
        child_session_id: &str,
        child_turn_id: &str,
    ) -> Result<Option<StoredSubsessionDirection>, BtccError> {
        self.repository
            .consume_direction(child_session_id.into(), child_turn_id.into(), (self.now)())
            .await
            .map_err(BtccError::from)
    }

    pub(crate) async fn recover_directions(&self) -> Result<(), BtccError> {
        let mut relations = std::collections::HashSet::new();
        for direction in self
            .repository
            .pending_directions()
            .await
            .map_err(BtccError::from)?
        {
            if !relations.insert(direction.relation_id.clone()) {
                continue;
            }
            let relation = self
                .repository
                .relation_by_id(direction.relation_id.clone())
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::SubsessionDirectionRelationMissing))?;
            let latest = self
                .repository
                .latest_turn(relation.child_session_id.clone())
                .await
                .map_err(BtccError::from)?;
            if latest.as_ref().is_none_or(|(_, state)| state != "admitted") {
                self.enqueue_direction(&relation, &direction).await?;
            }
        }
        Ok(())
    }

    async fn enqueue_direction(
        &self,
        relation: &StoredSubsessionDelegation,
        requested: &StoredSubsessionDirection,
    ) -> Result<(), BtccError> {
        let direction = self
            .repository
            .pending_direction(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .unwrap_or_else(|| requested.clone());
        let child = self
            .bindings
            .get_by_session_id(&relation.child_session_id)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionDirectionChildBindingMissing))?;
        if !matches!(child.role, SessionRole::Steward | SessionRole::Worker) {
            return Err(error(BtccCode::SubsessionDirectionChildBindingMissing));
        }
        let role = if child.role == SessionRole::Worker {
            "worker"
        } else {
            "steward"
        };
        let turn_id = format!(
            "subsession-direction-turn-{}",
            &crate::btcc::digest_identity(&direction.instruction_id)[..32]
        );
        self.queue.enqueue(super::SubsessionEnqueue {
            envelope: json!({
            "eventId":format!("subsession-direction:{}",direction.instruction_id),"transport":"app","accountId":"local",
            "peer":{"kind":"dm","id":relation.child_session_id,"parentId":relation.parent_session_id},
            "sender":{"id":if role=="worker"{"steward-worker-direction"}else{"butler-steward-direction"},"displayName":if role=="worker"{"Steward"}else{"Butler"}},
            "message":{"id":format!("subsession-direction-message:{}",direction.instruction_id),"text":format!("{}\n\nContinue the existing Work from its retained checkpoint. Review the new direction against the existing result; do not restart completed actions or create a replacement Work.",direction.instruction),"timestamp":direction.created_at},
            "routingHints":{"sessionId":relation.child_session_id,"turnId":turn_id},
            "nativeStewardContext":{"version":1,"role":role,"projectName":child.project_id.unwrap_or_default(),"workspacePath":child.workspace_path,"modelRef":child.model_ref,"reasoningEffort":child.metadata.as_ref().and_then(|m|m.get("reasoning_effort")).and_then(Value::as_str).unwrap_or("")},
            "raw":{"source":"btcc-subsession-direction","instruction_id":direction.instruction_id}
            }),
            metadata: serde_json::Map::new(),
        })
    }

    /// The single active relation the query addresses. Direction may follow
    /// up on a finished relation whose root Work is still open; cancellation
    /// only addresses unfinished ones.
    async fn select_relation(
        &self,
        query: RelationQuery<'_>,
    ) -> Result<StoredSubsessionDelegation, BtccError> {
        let candidates = self.candidate_relations(&query).await?;
        let owned = self.owned_relations(&query, candidates).await?;
        let mut eligible = Vec::new();
        for candidate in owned {
            if self.relation_is_eligible(&query, &candidate).await? {
                eligible.push(candidate);
            }
        }
        let mut eligible = eligible.into_iter();
        match (eligible.next(), eligible.next()) {
            (None, _) => Err(error(BtccCode::ActiveStewardRelationNotFound)),
            (Some(relation), None) => Ok(relation),
            (Some(_), Some(_)) => Err(error(BtccCode::ActiveStewardRelationAmbiguous)),
        }
    }

    /// Relations of the addressed role matching the id and title filters: by
    /// open Work when directing with a Work id, else the parent's relations.
    async fn candidate_relations(
        &self,
        query: &RelationQuery<'_>,
    ) -> Result<Vec<StoredSubsessionDelegation>, BtccError> {
        let mut candidates = match (query.purpose, query.work_id) {
            (RelationPurpose::Direct, Some(work)) => self
                .repository
                .open_relation_by_work(work.into())
                .await
                .map_err(BtccError::from)?
                .into_iter()
                .collect(),
            _ => self
                .repository
                .relations_for_parent(query.parent.into())
                .await
                .map_err(BtccError::from)?,
        };
        let role = if *query.role == SessionRole::Worker {
            "worker"
        } else {
            "steward"
        };
        candidates.retain(|candidate| {
            query
                .relation_id
                .is_none_or(|id| candidate.relation_id == id)
                && query
                    .title
                    .is_none_or(|value| candidate.safe_title == value)
                && candidate.packet.child_role.as_str() == role
        });
        Ok(candidates)
    }

    /// Keeps the relations the parent may address: its own children, or with
    /// a Work id, children bound to the same ledger and app project.
    async fn owned_relations(
        &self,
        query: &RelationQuery<'_>,
        candidates: Vec<StoredSubsessionDelegation>,
    ) -> Result<Vec<StoredSubsessionDelegation>, BtccError> {
        let source = self
            .bindings
            .get_by_session_id(query.parent)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::StewardFollowupAuthorityMismatch))?;
        let expected_parent = if *query.role == SessionRole::Worker {
            SessionRole::Steward
        } else {
            SessionRole::Butler
        };
        if source.role != expected_parent {
            return Err(error(BtccCode::StewardFollowupAuthorityMismatch));
        }
        let source_project = source
            .app_project_id
            .as_ref()
            .or(source.project_id.as_ref());
        let mut owned = Vec::new();
        for candidate in candidates {
            let child = self
                .bindings
                .get_by_session_id(&candidate.child_session_id)
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::StewardFollowupAuthorityMismatch))?;
            let same_parent = candidate.parent_session_id == query.parent;
            let same_project = query.work_id.is_some()
                && source.ledger_project_id.is_some()
                && source.ledger_project_id == child.ledger_project_id
                && source_project.is_some()
                && source_project == child.app_project_id.as_ref().or(child.project_id.as_ref());
            if same_parent || same_project {
                owned.push(candidate);
            }
        }
        Ok(owned)
    }

    /// An unfinished relation is eligible; a finished one only for a
    /// follow-up direction addressed by Work or relation id whose root Work
    /// is still open.
    async fn relation_is_eligible(
        &self,
        query: &RelationQuery<'_>,
        candidate: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        let terminal = self
            .repository
            .result_for_relation(candidate.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some();
        if !terminal {
            return Ok(true);
        }
        if query.purpose != RelationPurpose::Direct
            || (query.work_id.is_none() && query.relation_id.is_none())
        {
            return Ok(false);
        }
        Ok(self
            .repository
            .open_relation_by_work(candidate.root_work_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some())
    }
}

/// Why a parent addresses one of its subsession relations.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RelationPurpose {
    /// Send new direction; may follow up on a finished relation.
    Direct,
    /// Cancel an unfinished relation.
    Cancel,
}

/// Which relation a direction or cancellation addresses.
struct RelationQuery<'a> {
    parent: &'a str,
    relation_id: Option<&'a str>,
    work_id: Option<&'a str>,
    title: Option<&'a str>,
    role: &'a SessionRole,
    purpose: RelationPurpose,
}
