//! Durable subsession orchestration and role-specific result routing.
use crate::btcc::subsessions::assignment::Child;

mod admission;
mod control;
mod delegation;
mod followup;
mod helpers;
mod projection;
mod recovery;
mod result_delivery;
mod selection;
mod session_control;
pub use session_control::SessionControlRequest;
#[cfg(test)]
pub(crate) mod tests;
mod worker;

pub use control::{SubsessionCancelRequest, SubsessionDirectionRequest, SubsessionResumeRequest};

use helpers::*;

use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::btcc::BtccCode;
use crate::btcc::{
    BtccError, ChildRole, DispatchIntent, DispatchMetadata, DurableWorkService, ParentResultRoute,
    PortFuture, SqliteSubsessionRepository,
};
use crate::workspace::{OwnOptional, SessionBindingStore, SessionRole, UpsertSessionBinding};

mod lifecycle;

/// A child dispatch that was interrupted and can be recovered.
#[derive(Clone, Debug)]
pub struct InterruptedSubsessionEvent {
    pub event_id: String,
    pub message_id: String,
    pub message: String,
    pub recovery_id: String,
}

/// A child-session envelope to enqueue.
#[derive(Clone, Debug)]
pub struct SubsessionEnqueue {
    /// Passthrough: the gateway inbound envelope (dispatch or control), stored verbatim by the queue.
    pub envelope: Value,
    /// Passthrough: queue record metadata, stored verbatim by the queue.
    pub metadata: Map<String, Value>,
}

/// The inbound queue child sessions are dispatched through.
pub trait SubsessionChildQueue: Send + Sync {
    /// Enqueues a child envelope.
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError>;
    /// The interrupted event of a child turn, if its dispatch was interrupted.
    fn interrupted_event(
        &self,
        event_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError>;
}

/// A configured worker: its model, reasoning effort, prompt and job.
#[derive(Clone, Debug)]
pub struct WorkerProfile {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub prompt: Option<String>,
    /// Passthrough: the configured job, opaque to BTCC.
    pub job: Value,
}

/// Reads configured worker profiles.
pub trait WorkerProfileReader: Send + Sync {
    /// Every configured profile.
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>>;
    /// The profile with `profile_id`, or the default profile.
    fn read(&self, profile_id: Option<String>) -> PortFuture<'_, WorkerProfile>;
}

/// A butler's request to delegate reviewed Work to a steward.
#[derive(Clone, Debug)]
pub struct StewardDelegationRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub anchor_message_id: String,
    pub request: String,
    pub task_id: Option<String>,
    pub part_id: Option<String>,
    pub previous_relation_id: Option<String>,
    pub safe_title: Option<String>,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub access_mode: String,
    /// The unattended schedule run delegating, if any (D8).
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
}

/// A steward's request to delegate one plan action to a worker.
#[derive(Clone, Debug)]
pub struct WorkerDelegationRequest {
    pub parent_session_id: String,
    pub parent_turn_id: String,
    pub anchor_message_id: String,
    pub source_tool_call_id: String,
    pub action_key: String,
    pub task_id: Option<String>,
    pub part_id: Option<String>,
    pub objective: String,
    pub acceptance_criteria: Vec<String>,
    pub implementation_brief: String,
    pub safe_title: Option<String>,
    pub profile_id: Option<String>,
    pub access_mode: String,
    /// The unattended schedule run delegating, if any (D8).
    pub schedule_run: Option<crate::btcc::ScheduleRunContext>,
}

/// Orchestrates durable steward and worker subsessions and routes their results.
#[derive(Clone)]
pub struct SubsessionService {
    repository: SqliteSubsessionRepository,
    bindings: SessionBindingStore,
    queue: Arc<dyn SubsessionChildQueue>,
    profiles: Arc<dyn WorkerProfileReader>,
    work: Arc<DurableWorkService>,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    changes: tokio::sync::broadcast::Sender<(String, String)>,
}

impl SubsessionService {
    /// A service over the subsession store, bindings, child queue and Work.
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
            changes: tokio::sync::broadcast::channel(256).0,
        }
    }

    /// Parent identity for a child lifecycle envelope, without loading transcripts.
    pub async fn hook_parent_session_id(
        &self,
        session: String,
    ) -> Result<Option<String>, BtccError> {
        Ok(self
            .repository
            .by_child(session)
            .await
            .map_err(BtccError::from)?
            .map(|relation| relation.parent_session_id.clone()))
    }

    /// Change notifications after durable child execution state transitions.
    pub fn subscribe_changes(&self) -> tokio::sync::broadcast::Receiver<(String, String)> {
        self.changes.subscribe()
    }

    /// Signals an execution transition; readers reload the canonical projection.
    pub async fn notify_execution_changed(&self, session: &str) -> Result<(), BtccError> {
        if let Some(relation) = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
        {
            let _ = self.changes.send((
                relation
                    .packet
                    .parent_chat_id
                    .clone()
                    .unwrap_or_else(|| relation.parent_session_id.clone()),
                session.into(),
            ));
        }
        Ok(())
    }

    /// Delegates a reviewed Steward-mode plan to a steward subsession. The
    /// delegation is idempotent: a repeated request replays the stored one.
    pub async fn delegate_steward(
        &self,
        request: StewardDelegationRequest,
    ) -> Result<Value, BtccError> {
        let parent = self
            .parent_binding(
                &request.parent_session_id,
                SessionRole::Butler,
                BtccCode::ParentButlerSessionRequired,
            )
            .await?;
        let prior_context = self.followup_context(&request).await?;
        let parent_chat_id = parent
            .transport_bindings
            .iter()
            .find(|binding| binding.transport == "app" && !binding.peer_id.trim().is_empty())
            .map(|binding| binding.peer_id.clone())
            .ok_or_else(|| error(BtccCode::ParentAppBindingRequired))?;
        let input = admission::AssignmentRequest {
            parent_session_id: request.parent_session_id,
            parent_turn_id: request.parent_turn_id,
            anchor_message_id: request.anchor_message_id,
            request: request.request,
            task_id: request.task_id,
            part_id: request.part_id,
            role: ChildRole::Steward,
            safe_title: request.safe_title,
            model_ref: request.model_ref,
            reasoning_effort: request.reasoning_effort,
            access_mode: request.access_mode,
            parent_chat_id: Some(parent_chat_id),
            prior_context,
            implementation_brief: None,
            worker_prompt: None,
            worker_profile: None,
            schedule_run: request.schedule_run,
        };
        let stored = self.admit_assignment(input, parent).await?;
        if self
            .repository
            .result_for_relation(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some()
        {
            return self.closed_feedback(&stored).await;
        }
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
    ) -> Result<Option<crate::btcc::subsessions::assignment::Child>, BtccError> {
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

    async fn create_child_binding(
        &self,
        stored: &crate::btcc::subsessions::assignment::Child,
        parent: &crate::workspace::StoredSessionBinding,
        role: SessionRole,
        // Passthrough: free-form session-binding metadata shared with the App runtime policy.
        metadata: Map<String, Value>,
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
                model_provider_id: stored
                    .packet
                    .model_ref
                    .split('/')
                    .next()
                    .unwrap_or("")
                    .into(),
                model_ref: stored.packet.model_ref.clone(),
                runtime_session_ref: None,
                provider_thread_ref: None,
                transport_bindings: Vec::new(),
                lifecycle_state: None,
                created_at: None,
                updated_at: None,
                last_active_at: None,
                metadata: Some(metadata),
            })
            .await
            .map_err(BtccError::from)?;
        Ok(())
    }
    async fn ensure_child_binding(
        &self,
        stored: &crate::btcc::subsessions::assignment::Child,
    ) -> Result<(), BtccError> {
        let role_name = stored.packet.child_role;
        let role = match role_name {
            ChildRole::Steward => SessionRole::Steward,
            ChildRole::Worker => SessionRole::Worker,
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
        let access = stored.packet.access_mode.as_str();
        let mut metadata = child_metadata(role_name, &stored.packet, access, &parent);
        if let Child::Assigned(assignment) = stored
            && let Some(subsession) = metadata
                .get_mut("subsession")
                .and_then(Value::as_object_mut)
        {
            subsession.insert("work_id".into(), json!(assignment.work_id));
            subsession.insert("task_id".into(), json!(assignment.task_id));
            subsession.insert("part_id".into(), json!(assignment.part_id));
            subsession.insert("attempt_id".into(), json!(assignment.attempt_id));
        }
        self.create_child_binding(stored, &parent, role, metadata)
            .await
    }
    async fn replay(
        &self,
        stored: &crate::btcc::subsessions::assignment::Child,
    ) -> Result<(), BtccError> {
        let Child::Assigned(assignment) = stored else {
            return Ok(());
        };
        let op_id = format!("child_dispatch:{}", assignment.attempt_id);
        let lookup = op_id.clone();
        let applied = self
            .repository
            .storage()
            .work_model_read(move |db| {
                Ok(db.query_row(
                    "SELECT state='applied' FROM wm_cross_db_intents WHERE op_id=?1",
                    [lookup],
                    |r| r.get::<_, bool>(0),
                )?)
            })
            .await
            .map_err(BtccError::from)?;
        if applied {
            return Ok(());
        }
        let intent = stored
            .dispatch_intent
            .as_ref()
            .ok_or_else(|| error(BtccCode::SubsessionDispatchIntentInvalid))?;
        let envelope = serde_json::to_value(&intent.envelope).map_err(|source| {
            error(BtccCode::SubsessionDispatchIntentInvalid).with_source(source)
        })?;
        self.queue.enqueue(SubsessionEnqueue {
            envelope,
            metadata: Map::new(),
        })?;
        self.repository
            .storage()
            .work_model_write(move |tx| {
                butler_work::store::mark_intent_applied(tx, &admission::context(), &op_id, 0)?;
                Ok(())
            })
            .await
            .map_err(BtccError::from)
    }
}
