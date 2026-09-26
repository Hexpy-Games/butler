//! Durable subsession orchestration and role-specific result routing.

mod control;
mod helpers;
mod projection;
mod result_delivery;
#[cfg(test)]
mod tests;
mod worker;

pub(crate) use control::{
    SubsessionCancelRequest, SubsessionDirectionRequest, SubsessionResumeRequest,
};

use helpers::*;

use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::btcc::{
    ActionStatus, BtccError, DurableWorkService, ExecutionMode, ParentResultRoute, PortFuture,
    SqliteSubsessionRepository, StartWorkInput, SubsessionCreate, WorkTurnScope, WorkView,
};
use crate::workspace::{OwnOptional, SessionBindingStore, SessionRole, UpsertSessionBinding};

#[derive(Clone, Debug)]
pub(crate) struct InterruptedSubsessionEvent {
    pub event_id: String,
    pub message_id: String,
    pub message: String,
    pub recovery_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct SubsessionEnqueue {
    pub envelope: Value,
    pub metadata: Map<String, Value>,
}

pub(crate) trait SubsessionChildQueue: Send + Sync {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError>;
    fn interrupted_event(
        &self,
        event_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError>;
}

#[derive(Clone, Debug)]
pub(crate) struct WorkerProfile {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub prompt: Option<String>,
    pub job: Value,
}

pub(crate) trait WorkerProfileReader: Send + Sync {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>>;
    fn read(&self, profile_id: Option<String>) -> PortFuture<'_, WorkerProfile>;
}

#[derive(Clone, Debug)]
pub(crate) struct StewardDelegationRequest {
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
pub(crate) struct WorkerDelegationRequest {
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
pub(crate) struct NativeSubsessionService {
    repository: SqliteSubsessionRepository,
    bindings: SessionBindingStore,
    queue: Arc<dyn SubsessionChildQueue>,
    profiles: Arc<dyn WorkerProfileReader>,
    work: Arc<DurableWorkService>,
    now: Arc<dyn Fn() -> String + Send + Sync>,
}

impl NativeSubsessionService {
    pub(crate) fn new(
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

    pub(crate) async fn delegate_steward(
        &self,
        request: StewardDelegationRequest,
        reviewed: &WorkView,
    ) -> Result<Value, BtccError> {
        let parent = self
            .bindings
            .get_by_session_id(&request.parent_session_id)
            .await
            .map_err(workspace)?
            .ok_or_else(|| error("parent_butler_session_required"))?;
        if parent.role != SessionRole::Butler {
            return Err(error("parent_butler_session_required"));
        }
        let plan = reviewed
            .current_plan
            .as_ref()
            .ok_or_else(|| error("delegation_reviewed_plan_required"))?;
        if plan.execution_mode != Some(ExecutionMode::Steward) {
            return Err(error("steward_delegation_plan_mode_required"));
        }
        let review = reviewed
            .latest_plan_review
            .as_ref()
            .filter(|r| {
                r.verdict == crate::btcc::ReviewVerdict::Accept
                    && r.bound_plan_revision_id.as_deref() == Some(&plan.plan_revision_id)
            })
            .ok_or_else(|| error("delegation_reviewed_plan_required"))?;
        let parent_chat_id = parent
            .transport_bindings
            .iter()
            .find(|binding| binding.transport == "app" && !binding.peer_id.trim().is_empty())
            .map(|binding| binding.peer_id.clone())
            .ok_or_else(|| error("parent_app_binding_required"))?;
        let identity = json!({"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"request":request.request,"work_id":reviewed.work_id,"plan_revision_id":plan.plan_revision_id,"review_revision_id":review.review_revision_id});
        let encoded =
            serde_json::to_string(&identity).map_err(|_| error("subsession_identity_invalid"))?;
        let delegation_id = format!(
            "delegation-{}",
            crate::btcc::digest_identity(&format!("btcc.subsession.delegation.v1\0{encoded}"))
        );
        if let Some(existing) = self
            .repository
            .by_delegation(delegation_id.clone())
            .await
            .map_err(storage)?
        {
            self.ensure_child_binding(&existing).await?;
            self.replay(&existing).await?;
            return Ok(delegation_output(&existing));
        }
        let relation_id = format!(
            "relation-{}",
            &crate::btcc::digest_identity(&format!("btcc.subsession.relation.v1\0{delegation_id}"))
                [..40]
        );
        let task_id = format!(
            "task-{}",
            &crate::btcc::digest_identity(&format!("btcc.subsession.task.v1\0{delegation_id}"))
                [..40]
        );
        let child_session_id = format!(
            "steward-{}",
            &crate::btcc::digest_identity(&format!(
                "btcc.subsession.child-session.v1\0{relation_id}"
            ))[..32]
        );
        let child_turn_id = format!(
            "steward-turn-{}",
            &crate::btcc::digest_identity(&format!("btcc.subsession.child-turn.v1\0{relation_id}"))
                [..32]
        );
        let mutation_call_id =
            format!("subsession-root-work:{delegation_id}:{task_id}:{child_session_id}");
        let root_work_id = format!(
            "guided-work-{}",
            crate::btcc::digest_identity(&format!("btcc-guided-work.v1\0work\0{mutation_call_id}"))
        );
        let now = (self.now)();
        let packet = json!({"child_role":"steward","delegation_id":delegation_id,"task_id":task_id,"parent_session_id":request.parent_session_id,"parent_turn_id":request.parent_turn_id,"parent_chat_id":parent_chat_id,"relation_id":relation_id,"access_mode":request.access_mode,"execution_mode":if request.access_mode=="read_only"{"read_only"}else{"mutation"},"objective":request.request,"acceptance_criteria":plan.checks,"task_or_plan_refs":[plan.plan_revision_id],"constraints_and_non_goals":[],"allowed_tools_and_effects":allowed_effects(&request.access_mode),"mutation_scope":mutation_scope(&request.access_mode),"parent_work_ref":{"work_id":reviewed.work_id,"session_id":reviewed.session_id,"turn_id":request.parent_turn_id,"plan_revision_id":plan.plan_revision_id,"review_revision_id":review.review_revision_id},"model_ref":request.model_ref,"reasoning_effort":request.reasoning_effort});
        let envelope = child_envelope(ChildEnvelopeInput {
            role: "steward",
            delegation: &delegation_id,
            child: &child_session_id,
            parent_id: &request.parent_session_id,
            turn: &child_turn_id,
            parent: &parent,
            model: &request.model_ref,
            reasoning: &request.reasoning_effort,
            text: render_steward_input(&packet),
            now: &now,
        });
        let intent =
            json!({"envelope":envelope,"metadata":{"source":"btcc-subsession-delegation"}});
        self.repository
            .create(SubsessionCreate {
                relation_id: relation_id.clone(),
                delegation_id: delegation_id.clone(),
                task_id,
                parent_session_id: request.parent_session_id,
                parent_turn_id: request.parent_turn_id,
                child_session_id: child_session_id.clone(),
                child_turn_id,
                anchor_message_id: request.anchor_message_id,
                safe_title: request
                    .safe_title
                    .unwrap_or_else(|| "Delegated task".into()),
                root_work_id,
                packet,
                dispatch_intent: intent,
                created_at: now,
            })
            .await
            .map_err(storage)?;
        let stored = self
            .repository
            .by_delegation(delegation_id)
            .await
            .map_err(storage)?
            .ok_or_else(|| error("subsession_persist_failed"))?;
        self.ensure_child_binding(&stored).await?;
        self.replay(&stored).await?;
        Ok(delegation_output(&stored))
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
                model_provider_id: stored.packet["model_ref"]
                    .as_str()
                    .unwrap_or("")
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .into(),
                model_ref: stored.packet["model_ref"].as_str().unwrap_or("").into(),
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
            .map_err(workspace)?;
        Ok(())
    }
    async fn ensure_child_binding(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let (role, role_name) = match stored.packet["child_role"].as_str() {
            Some("steward") => (SessionRole::Steward, "steward"),
            Some("worker") => (SessionRole::Worker, "worker"),
            _ => return Err(error("subsession_child_role_invalid")),
        };
        if let Some(existing) = self
            .bindings
            .get_by_session_id(&stored.child_session_id)
            .await
            .map_err(workspace)?
        {
            if existing.role != role {
                return Err(error("subsession_child_binding_mismatch"));
            }
            return Ok(());
        }
        let parent = self
            .bindings
            .get_by_session_id(&stored.parent_session_id)
            .await
            .map_err(workspace)?
            .ok_or_else(|| error("subsession_parent_binding_missing"))?;
        let access = stored.packet["access_mode"]
            .as_str()
            .ok_or_else(|| error("subsession_access_mode_invalid"))?;
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
            .ok_or_else(|| error("subsession_dispatch_intent_invalid"))?;
        self.queue.enqueue(SubsessionEnqueue {
            envelope,
            metadata: Map::new(),
        })?;
        self.repository
            .mark_enqueued(stored.relation_id.clone())
            .await
            .map_err(storage)
    }
    pub(crate) async fn ensure_child_work(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<(), BtccError> {
        let stored = self
            .repository
            .by_child(session.into())
            .await
            .map_err(storage)?
            .ok_or_else(|| error("subsession_relation_missing"))?;
        let binding = self
            .bindings
            .get_by_session_id(session)
            .await
            .map_err(workspace)?
            .ok_or_else(|| error("subsession_child_binding_missing"))?;
        let scope = child_work_scope(&stored, &binding, turn)?;
        let existing = self.work.bound_work_for_turn(turn.into()).await?;
        if let Some(existing) = existing {
            if existing.work_id != stored.root_work_id
                || existing.session_id != session
                || !work_matches_scope(&existing, &scope)
            {
                return Err(error("subsession_root_work_identity_mismatch"));
            }
            return Ok(());
        }
        if turn != stored.child_turn_id {
            let bound = self
                .work
                .bind_open_work(scope.clone(), Some(stored.root_work_id.clone()))
                .await?
                .ok_or_else(|| error("subsession_root_work_identity_mismatch"))?;
            if bound.work_id != stored.root_work_id
                || bound.session_id != session
                || !work_matches_scope(&bound, &scope)
            {
                return Err(error("subsession_root_work_identity_mismatch"));
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
                objective: stored.packet["objective"]
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
            return Err(error("subsession_root_work_identity_mismatch"));
        }
        Ok(())
    }
    pub(crate) async fn complete_child(
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
                .map_err(storage)?,
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
            .map_err(storage)?;
        self.deliver_worker_results().await
    }
    pub(crate) async fn recover_dispatches(&self) -> Result<(), BtccError> {
        for stored in self
            .repository
            .pending_dispatches()
            .await
            .map_err(storage)?
        {
            self.ensure_child_binding(&stored).await?;
            self.replay(&stored).await?;
        }
        self.recover_directions().await?;
        self.deliver_worker_results().await
    }
    pub(crate) async fn should_wait_for_child(&self, parent: &str) -> Result<bool, BtccError> {
        self.repository
            .has_active_child(parent.to_owned())
            .await
            .map_err(storage)
    }
    pub(crate) async fn has_unfinished_execution(
        &self,
        session_id: &str,
    ) -> Result<bool, BtccError> {
        self.repository
            .has_unfinished_execution(session_id.to_owned())
            .await
            .map_err(storage)
    }
    pub(crate) fn repository(&self) -> SqliteSubsessionRepository {
        self.repository.clone()
    }
    pub(crate) async fn enabled_worker_profiles(&self) -> Result<Vec<WorkerProfile>, BtccError> {
        Ok(self
            .profiles
            .list()
            .await?
            .into_iter()
            .filter(|profile| profile.enabled)
            .collect())
    }
}
