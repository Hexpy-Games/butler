mod validation;

//! Durable direction revisions and cancellation over the shared native queue.

use crate::btcc::storage::SubsessionDispatchState;

use serde_json::{Value, json};

use super::selection::{RelationPurpose, RelationQuery};
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
    /// Queue by default; immediate steering requires an active child turn.
    pub immediate: bool,
    pub child_role: SessionRole,
    pub access_mode: String,
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
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
    /// Whether the child's latest turn still runs: admitted and without a saved
    /// result. An interrupted turn closed with a failed result stays `admitted`
    /// in the turn store but no longer holds back a direction.
    pub(super) async fn child_turn_running(&self, child_session: &str) -> Result<bool, BtccError> {
        let Some((turn, state)) = self
            .repository
            .latest_turn(child_session.to_owned())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(false);
        };
        if state != "admitted" {
            return Ok(false);
        }
        Ok(!self
            .repository
            .has_turn_result(child_session.to_owned(), turn)
            .await
            .map_err(BtccError::from)?)
    }

    /// Whether a direction is still waiting for or running on this child.
    pub(super) async fn steward_continuing(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        Ok(self
            .repository
            .pending_direction(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some()
            || self.child_turn_running(&relation.child_session_id).await?)
    }

    /// Enqueues the child's pending direction once its latest turn has ended.
    pub(super) async fn release_pending_direction(
        &self,
        child_session: &str,
    ) -> Result<(), BtccError> {
        let Some(relation) = self
            .repository
            .by_child(child_session.to_owned())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(());
        };
        let Some(direction) = self
            .repository
            .pending_direction(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(());
        };
        if self.child_turn_running(child_session).await? {
            return Ok(());
        }
        self.enqueue_direction(&relation, &direction).await
    }

    /// Sends new direction to a subsession.
    pub async fn steer(&self, request: SubsessionDirectionRequest) -> Result<Value, BtccError> {
        let _admission = self.worker_delegation.lock().await;
        self.steer_locked(request).await
    }

    pub(super) async fn steer_locked(
        &self,
        request: SubsessionDirectionRequest,
    ) -> Result<Value, BtccError> {
        let instruction = self.direction_instruction(&request).await?;
        let instruction = instruction.as_str();
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
        if !self.relation_is_eligible(&relation).await? {
            return self.closed_feedback(&relation).await;
        }
        if let Some(error) = self.task_direction_error(&relation).await? {
            return Ok(error);
        }
        self.repository
            .restrict_instruction_context(
                relation.relation_id.clone(),
                request.schedule_run.clone(),
            )
            .await
            .map_err(BtccError::from)?;
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
                (request.immediate, (self.now)()),
            )
            .await
            .map_err(BtccError::from)?;
        let Some(direction) = direction else {
            return self.closed_feedback(&relation).await;
        };
        if direction.instruction_id != instruction_id || direction.instruction != instruction {
            return Err(error(BtccCode::StewardDirectionIdentityConflict));
        }
        if !self.child_turn_running(&relation.child_session_id).await? {
            self.enqueue_direction(&relation, &direction).await?;
        }
        Ok(
            json!({"ok":true,"instruction_id":direction.instruction_id,"relation_id":relation.relation_id,"revision":direction.revision,"status":if request.immediate {"pending"} else {"queued"}}),
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
        let turn_id = self.cancel_turn(&relation).await?;
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
        if relation.packet.child_role == crate::btcc::ChildRole::Worker
            && let Err(error) = self.admit_waiting(&relation.parent_session_id).await
        {
            butler_core::diagnostic!(
                "[native-btcc] Worker post-cancel admission deferred code={}",
                error.code()
            );
        }
        Ok(
            json!({"relation_id":relation.relation_id,"child_turn_id":turn_id,"status":"cancelling","request_id":request_id}),
        )
    }

    async fn cancel_turn(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<String, BtccError> {
        if relation.packet.child_role == crate::btcc::ChildRole::Worker {
            return self
                .repository
                .cancel_worker_pending(relation.relation_id.clone(), (self.now)())
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::ActiveStewardRelationNotFound));
        }
        if self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some()
            && !self.child_turn_running(&relation.child_session_id).await?
        {
            // Nothing runs yet: stopping retires the directions still waiting.
            return self
                .repository
                .retire_pending_directions(relation.relation_id.clone(), (self.now)())
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::ActiveStewardRelationNotFound));
        }
        Ok(self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?
            .map(|(id, _)| id)
            .unwrap_or_else(|| relation.child_turn_id.clone()))
    }

    /// Stop in-flight executor futures after their authority was durably fenced.
    pub(super) async fn stop_closed_turn(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<(), BtccError> {
        let request = format!("delegation-closed:{turn}");
        self.enqueue_child(super::SubsessionEnqueue {
            envelope: json!({
                "eventId":request,"transport":"app","accountId":"local",
                "peer":{"kind":"dm","id":session},
                "sender":{"id":"subsession-parent-cancel","displayName":"Parent"},
                "message":{"id":request,"text":"","timestamp":(self.now)()},
                "routingHints":{"sessionId":session,"turnId":turn},
                "control":{"kind":"cancel_turn","requestId":request,"turnId":turn,"requestedAt":(self.now)()}
            }),
            metadata: serde_json::Map::new(),
        }).await
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
            if relations.contains(&direction.relation_id) {
                continue;
            }
            let relation = self
                .repository
                .relation_by_id(direction.relation_id.clone())
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::SubsessionDirectionRelationMissing))?;
            // A continuation whose result was saved without settling its
            // direction has ended; settle it so the relation's next one runs.
            if self
                .repository
                .settle_ended_direction(
                    relation.child_session_id.clone(),
                    direction.instruction_id.clone(),
                    (self.now)(),
                )
                .await
                .map_err(BtccError::from)?
            {
                continue;
            }
            relations.insert(direction.relation_id.clone());
            if relation.packet.child_role == crate::btcc::ChildRole::Worker {
                self.repository
                    .restore_waiting_direction(relation.relation_id.clone())
                    .await
                    .map_err(BtccError::from)?;
            }
            if relation.packet.child_role != crate::btcc::ChildRole::Worker
                && !self.child_turn_running(&relation.child_session_id).await?
            {
                self.enqueue_direction(&relation, &direction).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn enqueue_direction(
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
        if relation.packet.child_role == crate::btcc::ChildRole::Worker {
            if self
                .repository
                .worker_turn_unsettled(relation.relation_id.clone())
                .await
                .map_err(BtccError::from)?
            {
                return Ok(());
            }
            let current = self
                .repository
                .relation_by_id(relation.relation_id.clone())
                .await
                .map_err(BtccError::from)?
                .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
            if current.dispatch_state != SubsessionDispatchState::Enqueued {
                return Box::pin(self.admit_waiting(&relation.parent_session_id)).await;
            }
        }
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
        let turn_id = crate::btcc::storage::direction_turn_id(&direction.instruction_id);
        let schedule_run = self
            .instruction_run_context(&relation.child_session_id)
            .await?;
        let text = self
            .direction_message(relation, &direction.instruction)
            .await?;
        self.enqueue_child(super::SubsessionEnqueue {
            envelope: json!({
            "eventId":format!("subsession-direction:{}",direction.instruction_id),"transport":"app","accountId":"local",
            "peer":{"kind":"dm","id":relation.child_session_id,"parentId":relation.parent_session_id},
            "sender":{"id":if role=="worker"{"steward-worker-direction"}else{"butler-steward-direction"},"displayName":if role=="worker"{"Steward"}else{"Butler"}},
            "message":{"id":format!("subsession-direction-message:{}",direction.instruction_id),"text":text,"timestamp":direction.created_at},
            "routingHints":{"sessionId":relation.child_session_id,"turnId":turn_id},
            "nativeStewardContext":{"version":1,"role":role,"scheduleRun":schedule_run,"projectName":child.project_id.unwrap_or_default(),"workspacePath":child.workspace_path,"modelRef":child.model_ref,"reasoningEffort":child.metadata.as_ref().and_then(|m|m.get("reasoning_effort")).and_then(Value::as_str).unwrap_or("")},
            "raw":{"source":"btcc-subsession-direction","instruction_id":direction.instruction_id}
            }),
            metadata: serde_json::Map::new(),
        }).await
    }
}
