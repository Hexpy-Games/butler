//! Durable direction revisions and cancellation over the shared native queue.

use serde_json::{Value, json};

use super::{NativeSubsessionService, error, storage};
use crate::btcc::{BtccError, StoredSubsessionDelegation, StoredSubsessionDirection};
use crate::workspace::SessionRole;

#[derive(Clone, Debug)]
pub(crate) struct SubsessionDirectionRequest {
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

#[derive(Clone, Debug)]
pub(crate) struct SubsessionCancelRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub source_message_id: String,
    pub relation_id: Option<String>,
    pub safe_title: Option<String>,
    pub child_role: SessionRole,
}

#[derive(Clone, Debug)]
pub(crate) struct SubsessionResumeRequest {
    pub parent_session_id: String,
    pub relation_id: String,
}

impl NativeSubsessionService {
    pub(crate) async fn resume(
        &self,
        request: SubsessionResumeRequest,
    ) -> Result<Value, BtccError> {
        let relation = self
            .repository
            .relation_by_id(request.relation_id.clone())
            .await
            .map_err(storage)?
            .filter(|relation| {
                relation.parent_session_id == request.parent_session_id
                    && relation.packet.get("child_role").and_then(Value::as_str) == Some("steward")
            })
            .ok_or_else(|| error("steward_relation_not_found"))?;
        let parent = self
            .bindings
            .get_by_session_id(&request.parent_session_id)
            .await
            .map_err(|value| BtccError::new(value.code, value.message))?
            .filter(|binding| binding.role == SessionRole::Butler)
            .ok_or_else(|| error("steward_relation_not_found"))?;
        let _ = parent;
        if self
            .repository
            .open_relation_by_work(relation.root_work_id.clone())
            .await
            .map_err(storage)?
            .is_none()
        {
            return Err(error("steward_relation_not_active"));
        }
        let turn = self
            .repository
            .latest_resume_turn(relation.child_session_id.clone())
            .await
            .map_err(storage)?
            .filter(|turn| turn.semantic_state == "admitted")
            .ok_or_else(|| error("steward_relation_not_active"))?;
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
            .ok_or_else(|| error("steward_relation_not_recoverable"))?;
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

    pub(crate) async fn steer(
        &self,
        request: SubsessionDirectionRequest,
    ) -> Result<Value, BtccError> {
        let instruction = crate::public_text::trim_js_whitespace(&request.instruction);
        if instruction.is_empty() {
            return Err(error("steward_direction_instruction_required"));
        }
        if instruction.chars().count() > 1_200 {
            return Err(error("steward_direction_instruction_too_long"));
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
                .map_err(storage)?
        {
            return Err(error("steward_followup_authority_mismatch"));
        }
        let relation = self
            .select_relation(
                &request.parent_session_id,
                request.relation_id.as_deref(),
                request.work_id.as_deref(),
                request.safe_title.as_deref(),
                &request.child_role,
                true,
            )
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
            .map_err(storage)?;
        if direction.instruction_id != instruction_id || direction.instruction != instruction {
            return Err(error("steward_direction_identity_conflict"));
        }
        let latest = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(storage)?;
        if latest.as_ref().is_none_or(|(_, state)| state != "admitted") {
            self.enqueue_direction(&relation, &direction).await?;
        }
        Ok(
            json!({"ok":true,"instruction_id":direction.instruction_id,"relation_id":relation.relation_id,"revision":direction.revision,"status":"pending"}),
        )
    }

    pub(crate) async fn cancel(
        &self,
        request: SubsessionCancelRequest,
    ) -> Result<Value, BtccError> {
        let relation = self
            .select_relation(
                &request.parent_session_id,
                request.relation_id.as_deref(),
                None,
                request.safe_title.as_deref(),
                &request.child_role,
                false,
            )
            .await?;
        if self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(storage)?
            .is_some()
        {
            return Err(error("active_steward_relation_not_found"));
        }
        let turn_id = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(storage)?
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

    pub(crate) async fn consume_direction(
        &self,
        child_session_id: &str,
        child_turn_id: &str,
    ) -> Result<Option<StoredSubsessionDirection>, BtccError> {
        self.repository
            .consume_direction(child_session_id.into(), child_turn_id.into(), (self.now)())
            .await
            .map_err(storage)
    }

    pub(crate) async fn recover_directions(&self) -> Result<(), BtccError> {
        let mut relations = std::collections::HashSet::new();
        for direction in self
            .repository
            .pending_directions()
            .await
            .map_err(storage)?
        {
            if !relations.insert(direction.relation_id.clone()) {
                continue;
            }
            let relation = self
                .repository
                .relation_by_id(direction.relation_id.clone())
                .await
                .map_err(storage)?
                .ok_or_else(|| error("subsession_direction_relation_missing"))?;
            let latest = self
                .repository
                .latest_turn(relation.child_session_id.clone())
                .await
                .map_err(storage)?;
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
            .map_err(storage)?
            .unwrap_or_else(|| requested.clone());
        let child = self
            .bindings
            .get_by_session_id(&relation.child_session_id)
            .await
            .map_err(|e| BtccError::new(e.code, e.message))?
            .ok_or_else(|| error("subsession_direction_child_binding_missing"))?;
        if !matches!(child.role, SessionRole::Steward | SessionRole::Worker) {
            return Err(error("subsession_direction_child_binding_missing"));
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

    async fn select_relation(
        &self,
        parent: &str,
        relation_id: Option<&str>,
        work_id: Option<&str>,
        title: Option<&str>,
        role: &SessionRole,
        allow_followup: bool,
    ) -> Result<StoredSubsessionDelegation, BtccError> {
        let mut candidates = if allow_followup {
            if let Some(work) = work_id {
                self.repository
                    .open_relation_by_work(work.into())
                    .await
                    .map_err(storage)?
                    .into_iter()
                    .collect()
            } else {
                self.repository
                    .relations_for_parent(parent.into())
                    .await
                    .map_err(storage)?
            }
        } else {
            self.repository
                .relations_for_parent(parent.into())
                .await
                .map_err(storage)?
        };
        candidates.retain(|candidate| {
            relation_id.is_none_or(|id| candidate.relation_id == id)
                && title.is_none_or(|value| candidate.safe_title == value)
                && candidate.packet.get("child_role").and_then(Value::as_str)
                    == Some(if *role == SessionRole::Worker {
                        "worker"
                    } else {
                        "steward"
                    })
        });
        let source = self
            .bindings
            .get_by_session_id(parent)
            .await
            .map_err(|e| BtccError::new(e.code, e.message))?
            .ok_or_else(|| error("steward_followup_authority_mismatch"))?;
        let expected_parent = if *role == SessionRole::Worker {
            SessionRole::Steward
        } else {
            SessionRole::Butler
        };
        if source.role != expected_parent {
            return Err(error("steward_followup_authority_mismatch"));
        }
        let mut owned = Vec::new();
        for candidate in candidates {
            let child = self
                .bindings
                .get_by_session_id(&candidate.child_session_id)
                .await
                .map_err(|e| BtccError::new(e.code, e.message))?
                .ok_or_else(|| error("steward_followup_authority_mismatch"))?;
            let same_parent = candidate.parent_session_id == parent;
            let same_project = work_id.is_some()
                && source.ledger_project_id.is_some()
                && source.ledger_project_id == child.ledger_project_id
                && source
                    .app_project_id
                    .as_ref()
                    .or(source.project_id.as_ref())
                    .is_some()
                && source
                    .app_project_id
                    .as_ref()
                    .or(source.project_id.as_ref())
                    == child.app_project_id.as_ref().or(child.project_id.as_ref());
            if same_parent || same_project {
                owned.push(candidate);
            }
        }
        candidates = owned;
        let mut eligible = Vec::new();
        for candidate in candidates {
            let terminal = self
                .repository
                .result_for_relation(candidate.relation_id.clone())
                .await
                .map_err(storage)?
                .is_some();
            if !terminal
                || (allow_followup
                    && (work_id.is_some() || relation_id.is_some())
                    && self
                        .repository
                        .open_relation_by_work(candidate.root_work_id.clone())
                        .await
                        .map_err(storage)?
                        .is_some())
            {
                eligible.push(candidate);
            }
        }
        candidates = eligible;
        match candidates.len() {
            0 => Err(error("active_steward_relation_not_found")),
            1 => Ok(candidates.remove(0)),
            _ => Err(error("active_steward_relation_ambiguous")),
        }
    }
}
