//! Durable direction revisions and cancellation over the shared native queue.
mod resume;
use crate::btcc::subsessions::assignment::Child;

use butler_core::json::at;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use super::selection::{RelationPurpose, RelationQuery};
use super::{ChildRole, SubsessionService, direction_text, error};
use crate::btcc::BtccCode;
use crate::btcc::{BtccError, StoredSubsessionDirection};
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
        let waiting_turn = turn.clone();
        let waiting = self
            .repository
            .storage()
            .work_model_read(move |db| {
                Ok(db
                    .query_row(
                        crate::btcc::storage::native_sql::SUBSESSIONS_SERVICE_WAITING_TURN,
                        [waiting_turn],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some())
            })
            .await
            .map_err(BtccError::from)?;
        if waiting {
            return Ok(false);
        }
        Ok(!self
            .repository
            .has_turn_result(child_session.to_owned(), turn)
            .await
            .map_err(BtccError::from)?)
    }

    /// Enqueues the child's pending direction once its latest turn has ended.
    pub(super) async fn release_pending_direction(
        &self,
        child_session: &str,
    ) -> Result<(), BtccError> {
        let target = child_session.to_owned();
        let held = self
            .repository
            .storage()
            .work_model_read(move |db| {
                Ok(!butler_work::store::active_session_holds(db, &target)?.is_empty())
            })
            .await
            .map_err(BtccError::from)?;
        if held {
            return Ok(());
        }
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
        if !self
            .relation_is_eligible(&RelationQuery::direction(&request), &relation)
            .await?
        {
            return self.closed_feedback(&relation).await;
        }
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
        if direction.instruction != instruction {
            return Err(error(BtccCode::StewardDirectionIdentityConflict));
        }
        self.release_stop_holds(&relation.child_session_id, &request.parent_session_id)
            .await?;
        if !self.child_turn_running(&relation.child_session_id).await? {
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
        let target = relation.child_session_id.clone();
        let parent = request.parent_session_id;
        let receipt = self
            .repository
            .storage()
            .work_model_write(move |tx| {
                butler_work::store::hold_session(
                    tx,
                    &super::admission::context(),
                    &target,
                    "stop",
                    &parent,
                )
            })
            .await
            .map_err(BtccError::from)?;
        let mut result = self.enqueue_cancel(&relation, &receipt.to_string()).await?;
        butler_core::json::object_mut(&mut result)
            .insert("hold_id".into(), at(&receipt, "/hold_id").clone());
        Ok(result)
    }

    async fn release_stop_holds(&self, target: &str, parent: &str) -> Result<bool, BtccError> {
        let target = target.to_owned();
        let parent = parent.to_owned();
        self.repository
            .storage()
            .work_model_write(move |tx| {
                use butler_work::store;
                let holds = store::active_session_holds(tx, &target)?;
                let mut released = false;
                for hold in holds {
                    if at(&hold, "/kind") == "stop"
                        && at(&hold, "/owner").as_str() == Some(parent.as_str())
                    {
                        store::release_session_hold(
                            tx,
                            &super::admission::context(),
                            at(&hold, "/id")
                                .as_str()
                                .ok_or(store::Error::Invalid("hold id"))?,
                            store::control_epoch(tx, &target)?,
                        )?;
                        released = true;
                    }
                }
                Ok(released)
            })
            .await
            .map_err(BtccError::from)
    }

    pub(super) async fn enqueue_cancel(
        &self,
        relation: &Child,
        identity: &str,
    ) -> Result<Value, BtccError> {
        if self.cancel_waiting(relation).await? {
            return Ok(
                json!({"relation_id":relation.relation_id,"child_turn_id":relation.child_turn_id,"status":"cancelled"}),
            );
        }
        let turn_id = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?
            .map(|(id, _)| id)
            .unwrap_or_else(|| relation.child_turn_id.clone());
        let request_id = format!(
            "cancel-steward-{}",
            &crate::btcc::digest_identity(identity)[..40]
        );
        let now = (self.now)();
        self.queue.enqueue(super::SubsessionEnqueue { envelope:json!({
            "eventId":format!("subsession-cancel:{request_id}"),"transport":"app","accountId":"local",
            "peer":{"kind":"dm","id":relation.child_session_id,"parentId":relation.parent_session_id},
            "sender":{"id":"subsession-parent-cancel","displayName":"Parent"},
            "message":{"id":format!("subsession-cancel-message:{request_id}"),"text":"","timestamp":now},
            "routingHints":{"sessionId":relation.child_session_id,"turnId":turn_id},
            "control":{"kind":"cancel_turn","requestId":request_id,"turnId":turn_id,"requestedAt":now}
        }), metadata:serde_json::Map::new() })?;
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
            if !self.child_turn_running(&relation.child_session_id).await? {
                self.enqueue_direction(&relation, &direction).await?;
            }
        }
        Ok(())
    }

    async fn direction_held(&self, relation: &Child) -> Result<bool, BtccError> {
        if relation.packet.child_role == ChildRole::Worker
            && self.dispatch_pending(relation).await?
        {
            return Ok(true);
        }
        let target = relation.child_session_id.clone();
        let assigned_part = match relation {
            Child::Assigned(assigned) => assigned.part_id.clone(),
            Child::Legacy(_) => None,
        };
        let whole_task =
            matches!(relation, Child::Assigned(assigned) if assigned.part_id.is_none());
        let task_id = relation.task_id.clone();
        self.repository
            .storage()
            .work_model_read(move |db| {
                use butler_work::store;
                if !store::active_session_holds(db, &target)?.is_empty() {
                    return Ok(true);
                }
                if whole_task {
                    let task = store::read_task(db, &task_id)?;
                    if at(&task, "/assignee_session_id").as_str() != Some(target.as_str()) {
                        return Ok(true);
                    }
                }
                if let Some(part) = assigned_part {
                    let part = store::read_part(db, &part)?;
                    let task = store::read_task(db, &task_id)?;
                    let completed = at(&part, "/status") == "completed";
                    let steering = store::pending_instructions(db, &target, false)?
                        .first()
                        .is_some_and(|row| at(row, "/mode") == "steer");
                    return Ok((completed || at(&task, "/status") == "in_review")
                        && !(completed && steering));
                }
                Ok(false)
            })
            .await
            .map_err(BtccError::from)
    }

    async fn enqueue_direction(
        &self,
        relation: &Child,
        requested: &StoredSubsessionDirection,
    ) -> Result<(), BtccError> {
        if self.direction_held(relation).await? {
            return Ok(());
        }
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
        let turn_id = crate::btcc::storage::direction_turn_id(&direction.instruction_id);
        self.queue.enqueue(super::SubsessionEnqueue {
            envelope: json!({
            "eventId":format!("subsession-direction:{}",direction.instruction_id),"transport":"app","accountId":"local",
            "peer":{"kind":"dm","id":relation.child_session_id,"parentId":relation.parent_session_id},
            "sender":{"id":if role=="worker"{"steward-worker-direction"}else{"butler-steward-direction"},"displayName":if role=="worker"{"Steward"}else{"Butler"}},
            "message":{"id":format!("subsession-direction-message:{}",direction.instruction_id),"text":direction_text(&direction.instruction),"timestamp":direction.created_at},
            "routingHints":{"sessionId":relation.child_session_id,"turnId":turn_id},
            "nativeStewardContext":{"version":1,"role":role,"projectName":child.project_id.unwrap_or_default(),"workspacePath":child.workspace_path,"modelRef":child.model_ref,"reasoningEffort":child.metadata.as_ref().and_then(|m|m.get("reasoning_effort")).and_then(Value::as_str).unwrap_or("")},
            "raw":{"source":"btcc-subsession-direction","instruction_id":direction.instruction_id}
            }),
            metadata: serde_json::Map::new(),
        })
    }
}
