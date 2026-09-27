//! Durable subsession orchestration and role-specific result routing.

mod control;
mod delegation;
mod helpers;
mod projection;
mod result_delivery;
#[cfg(test)]
mod tests;
mod worker;

pub use control::{SubsessionCancelRequest, SubsessionDirectionRequest, SubsessionResumeRequest};

use butler_core::json;
use delegation::accepted_plan;
use helpers::*;

use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::btcc::BtccCode;
use crate::btcc::{
    ActionStatus, BtccError, DurableWorkService, ExecutionMode, ParentResultRoute, PortFuture,
    SqliteSubsessionRepository, StartWorkInput, SubsessionCreate, WorkTurnScope, WorkView,
};
use crate::workspace::{OwnOptional, SessionBindingStore, SessionRole, UpsertSessionBinding};

#[derive(Clone, Debug)]
pub struct InterruptedSubsessionEvent {
    pub event_id: String,
    pub message_id: String,
    pub message: String,
    pub recovery_id: String,
}

#[derive(Clone, Debug)]
pub struct SubsessionEnqueue {
    pub envelope: Value,
    pub metadata: Map<String, Value>,
}

pub trait SubsessionChildQueue: Send + Sync {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError>;
    fn interrupted_event(
        &self,
        event_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError>;
}

#[derive(Clone, Debug)]
pub struct WorkerProfile {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub prompt: Option<String>,
    pub job: Value,
}

pub trait WorkerProfileReader: Send + Sync {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>>;
    fn read(&self, profile_id: Option<String>) -> PortFuture<'_, WorkerProfile>;
}

#[derive(Clone, Debug)]
pub struct StewardDelegationRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub anchor_message_id: String,
    pub request: String,
    pub safe_title: Option<String>,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub access_mode: String,
}

#[derive(Clone, Debug)]
pub struct WorkerDelegationRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub anchor_message_id: String,
    pub source_tool_call_id: String,
    pub action_key: String,
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub implementation_brief: String,
    pub safe_title: Option<String>,
    pub profile_id: Option<String>,
    pub access_mode: String,
}

#[derive(Clone)]
pub struct SubsessionService {
    repository: SqliteSubsessionRepository,
    bindings: SessionBindingStore,
    queue: Arc<dyn SubsessionChildQueue>,
    profiles: Arc<dyn WorkerProfileReader>,
    work: Arc<DurableWorkService>,
    now: Arc<dyn Fn() -> String + Send + Sync>,
}

impl SubsessionService {
    pub fn new(
        repository: SqliteSubsessionRepository,
        bindings: SessionBindingStore,
        queue: Arc<dyn SubsessionChildQueue>,
        profiles: Arc<dyn WorkerProfileReader>,
        work: Arc<DurableWorkService>,
        now: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            repository,
            bindings,
            queue,
            profiles,
            work,
            now,
        }
    }

    /// Delegates a reviewed Steward-mode plan to a steward subsession. The
    /// delegation is idempotent: a repeated request replays the stored one.
    pub async fn delegate_steward(
        &self,
        request: StewardDelegationRequest,
        reviewed: &WorkView,
    ) -> Result<Value, BtccError> {
        let parent = self
            .parent_binding(
                &request.parent_session_id,
                SessionRole::Butler,
                BtccCode::ParentButlerSessionRequired,
            )
            .await?;
        let (plan, review) = accepted_plan(
            reviewed,
            ExecutionMode::Steward,
            BtccCode::StewardDelegationPlanModeRequired,
        )?;
        let parent_chat_id = parent
            .transport_bindings
            .iter()
            .find(|binding| binding.transport == "app" && !binding.peer_id.trim().is_empty())
            .map(|binding| binding.peer_id.clone())
            .ok_or_else(|| error(BtccCode::ParentAppBindingRequired))?;
        let identity = json!({"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"request":request.request,"work_id":reviewed.work_id,"plan_revision_id":plan.plan_revision_id,"review_revision_id":review.review_revision_id});
        let delegation_id = delegation::delegation_id(&delegation::STEWARD, &identity)?;
        if let Some(existing) = self.replay_existing(&delegation_id).await? {
            return Ok(delegation_output(&existing));
        }
        let ids = delegation::DelegationIds::derive(&delegation::STEWARD, delegation_id);
        let now = (self.now)();
        let packet = json!({"child_role":"steward","delegation_id":ids.delegation_id,"task_id":ids.task_id,"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"parent_chat_id":parent_chat_id,"relation_id":ids.relation_id,"access_mode":request.access_mode,"execution_mode":if request.access_mode=="read_only"{"read_only"}else{"mutation"},"objective":request.request,"acceptance_criteria":plan.checks,"task_or_plan_refs":[plan.plan_revision_id],"constraints_and_non_goals":[],"allowed_tools_and_effects":allowed_effects(&request.access_mode),"mutation_scope":mutation_scope(&request.access_mode),"parent_work_ref":{"work_id":reviewed.work_id,"session_id":reviewed.session_id,"turn_id":request.parent_turn_id,"plan_revision_id":plan.plan_revision_id,"review_revision_id":review.review_revision_id},"model_ref":request.model_ref,"reasoning_effort":request.reasoning_effort});
        let envelope = child_envelope(ChildEnvelopeInput {
            role: "steward",
            delegation: &ids.delegation_id,
            child: &ids.child_session_id,
            parent_id: &request.parent_session_id,
            turn: &ids.child_turn_id,
            parent: &parent,
            model: &request.model_ref,
            reasoning: &request.reasoning_effort,
            text: render_steward_input(&packet),
            now: &now,
        });
        let intent =
            json!({"envelope":envelope,"metadata":{"source":"btcc-subsession-delegation"}});
        let stored = self
            .create_and_dispatch(
                ids.create(
                    delegation::Parent {
                        session_id: request.parent_session_id,
                        turn_id: request.parent_turn_id,
                        anchor_message_id: request.anchor_message_id,
                    },
                    request
                        .safe_title
                        .unwrap_or_else(|| "Delegated task".into()),
                    packet,
                    intent,
                    now,
                ),
            )
            .await?;
        Ok(delegation_output(&stored))
    }

    /// The parent session's binding, which must have `role`.
    async fn parent_binding(
        &self,
        session_id: &str,
        role: SessionRole,
        code: BtccCode,
    ) -> Result<crate::workspace::StoredSessionBinding, BtccError> {
        let parent = self
            .bindings
            .get_by_session_id(session_id)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(code))?;
        if parent.role != role {
            return Err(error(code));
        }
        Ok(parent)
    }

    /// Re-dispatches a delegation that already exists.
    async fn replay_existing(
        &self,
        delegation_id: &str,
    ) -> Result<Option<crate::btcc::StoredSubsessionDelegation>, BtccError> {
        let Some(existing) = self
            .repository
            .by_delegation(delegation_id.to_owned())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(None);
        };
        self.ensure_child_binding(&existing).await?;
        self.replay(&existing).await?;
        Ok(Some(existing))
    }

    /// Persists a new delegation, binds its child session and dispatches it.
    async fn create_and_dispatch(
        &self,
        create: SubsessionCreate,
    ) -> Result<crate::btcc::StoredSubsessionDelegation, BtccError> {
        let delegation_id = create.delegation_id.clone();
        self.repository
            .create(create)
            .await
            .map_err(BtccError::from)?;
        let stored = self
            .repository
            .by_delegation(delegation_id)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionPersistFailed))?;
        self.ensure_child_binding(&stored).await?;
        self.replay(&stored).await?;
        Ok(stored)
    }

    async fn create_child_binding(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
        parent: &crate::workspace::StoredSessionBinding,
        role: SessionRole,
        metadata: Value,
    ) -> Result<(), BtccError> {
        self.bindings
            .upsert(UpsertSessionBinding {
                session_id: stored.child_session_id.clone(),
                role,
                project_id: parent.project_id.clone(),
                app_project_id: parent
                    .app_project_id
                    .clone()
                    .map_or(OwnOptional::Null, OwnOptional::Value),
                ledger_project_id: parent
                    .ledger_project_id
                    .clone()
                    .map_or(OwnOptional::Null, OwnOptional::Value),
                workspace_path: parent.workspace_path.clone(),
                runtime_adapter_id: "btcc-turn-runtime".into(),
                model_provider_id: json::at(&stored.packet, "/model_ref")
                    .as_str()
                    .unwrap_or("")
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .into(),
                model_ref: json::at(&stored.packet, "/model_ref")
                    .as_str()
                    .unwrap_or("")
                    .into(),
                runtime_session_ref: None,
                provider_thread_ref: None,
                transport_bindings: Vec::new(),
                lifecycle_state: None,
                created_at: None,
                updated_at: None,
                last_active_at: None,
                metadata: metadata.as_object().cloned(),
            })
            .await
            .map_err(BtccError::from)?;
        Ok(())
    }
    async fn ensure_child_binding(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let (role, role_name) = match json::at(&stored.packet, "/child_role").as_str() {
            Some("steward") => (SessionRole::Steward, "steward"),
            Some("worker") => (SessionRole::Worker, "worker"),
            _ => return Err(error(BtccCode::SubsessionChildRoleInvalid)),
        };
        if let Some(existing) = self
            .bindings
            .get_by_session_id(&stored.child_session_id)
            .await
            .map_err(BtccError::from)?
        {
            if existing.role != role {
                return Err(error(BtccCode::SubsessionChildBindingMismatch));
            }
            return Ok(());
        }
        let parent = self
            .bindings
            .get_by_session_id(&stored.parent_session_id)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionParentBindingMissing))?;
        let access = json::at(&stored.packet, "/access_mode")
            .as_str()
            .ok_or_else(|| error(BtccCode::SubsessionAccessModeInvalid))?;
        let metadata = child_metadata(role_name, &stored.packet, access, &parent);
        self.create_child_binding(stored, &parent, role, metadata)
            .await
    }
    async fn replay(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let envelope = stored
            .dispatch_intent
            .get("envelope")
            .cloned()
            .ok_or_else(|| error(BtccCode::SubsessionDispatchIntentInvalid))?;
        self.queue.enqueue(SubsessionEnqueue {
            envelope,
            metadata: Map::new(),
        })?;
        self.repository
            .mark_enqueued(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)
    }
    pub async fn ensure_child_work(&self, session: &str, turn: &str) -> Result<(), BtccError> {
        let stored = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionRelationMissing))?;
        let binding = self
            .bindings
            .get_by_session_id(session)
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::SubsessionChildBindingMissing))?;
        let scope = child_work_scope(&stored, &binding, turn)?;
        let existing = self.work.bound_work_for_turn(turn.into()).await?;
        if let Some(existing) = existing {
            if existing.work_id != stored.root_work_id
                || existing.session_id != session
                || !work_matches_scope(&existing, &scope)
            {
                return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
            }
            return Ok(());
        }
        if turn != stored.child_turn_id {
            let bound = self
                .work
                .bind_open_work(scope.clone(), Some(stored.root_work_id.clone()))
                .await?
                .ok_or_else(|| error(BtccCode::SubsessionRootWorkIdentityMismatch))?;
            if bound.work_id != stored.root_work_id
                || bound.session_id != session
                || !work_matches_scope(&bound, &scope)
            {
                return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
            }
            return Ok(());
        }
        let mutation = format!(
            "subsession-root-work:{}:{}:{}",
            stored.delegation_id, stored.task_id, stored.child_session_id
        );
        let work = self
            .work
            .start_work(StartWorkInput {
                scope,
                mutation_call_id: mutation,
                objective: json::at(&stored.packet, "/objective")
                    .as_str()
                    .unwrap_or("Complete the bounded subsession task.")
                    .into(),
                backfill_tool_call_ids: None,
            })
            .await?;
        if work.work_id != stored.root_work_id
            || work.session_id != session
            || !work_matches_scope(&work, &child_work_scope(&stored, &binding, turn)?)
        {
            return Err(error(BtccCode::SubsessionRootWorkIdentityMismatch));
        }
        Ok(())
    }
    pub async fn complete_child(
        &self,
        session: &str,
        turn: &str,
        status: &str,
        summary: String,
    ) -> Result<(), BtccError> {
        self.ensure_child_work(session, turn).await?;
        if status == "cancelled" {
            self.work
                .abandon_bound_work_for_turn(turn.to_owned())
                .await?;
        }
        let mut evidence_refs = self
            .work
            .bound_work_for_turn(turn.to_owned())
            .await?
            .and_then(|work| work.latest_disposition)
            .map(|disposition| disposition.evidence_snapshot)
            .unwrap_or_default();
        evidence_refs.extend(
            self.repository
                .child_result_evidence(session.to_owned())
                .await
                .map_err(BtccError::from)?,
        );
        evidence_refs.sort();
        evidence_refs.dedup();
        self.repository
            .commit_result(
                session.into(),
                turn.into(),
                status.into(),
                summary,
                evidence_refs,
                (self.now)(),
            )
            .await
            .map_err(BtccError::from)?;
        self.deliver_worker_results().await
    }
    pub async fn recover_dispatches(&self) -> Result<(), BtccError> {
        for stored in self
            .repository
            .pending_dispatches()
            .await
            .map_err(BtccError::from)?
        {
            self.ensure_child_binding(&stored).await?;
            self.replay(&stored).await?;
        }
        self.recover_directions().await?;
        self.deliver_worker_results().await
    }
    pub async fn should_wait_for_child(&self, parent: &str) -> Result<bool, BtccError> {
        self.repository
            .has_active_child(parent.to_owned())
            .await
            .map_err(BtccError::from)
    }
    pub async fn has_unfinished_execution(&self, session_id: &str) -> Result<bool, BtccError> {
        self.repository
            .has_unfinished_execution(session_id.to_owned())
            .await
            .map_err(BtccError::from)
    }
    pub fn repository(&self) -> SqliteSubsessionRepository {
        self.repository.clone()
    }
    pub async fn enabled_worker_profiles(&self) -> Result<Vec<WorkerProfile>, BtccError> {
        Ok(self
            .profiles
            .list()
            .await?
            .into_iter()
            .filter(|profile| profile.enabled)
            .collect())
    }
}
