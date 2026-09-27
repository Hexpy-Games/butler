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

use delegation::accepted_plan;
use helpers::*;

use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::btcc::BtccCode;
use crate::btcc::{
    ActionStatus, BtccError, ChildRole, DispatchIntent, DispatchMetadata, DurableWorkService,
    ExecutionMode, ParentResultRoute, PortFuture, SqliteSubsessionRepository, StartWorkInput,
    SubsessionCreate, WorkTurnScope, WorkView,
};
use crate::workspace::{OwnOptional, SessionBindingStore, SessionRole, UpsertSessionBinding};

mod lifecycle;
mod packets;

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
    pub safe_title: Option<String>,
    pub model_ref: String,
    pub reasoning_effort: String,
    pub access_mode: String,
}

/// A steward's request to delegate one plan action to a worker.
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

/// Orchestrates durable steward and worker subsessions and routes their results.
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
        let identity = packets::steward_identity(&request, reviewed, (plan, review));
        let delegation_id = delegation::delegation_id(&delegation::STEWARD, &identity)?;
        if let Some(existing) = self.replay_existing(&delegation_id).await? {
            return Ok(delegation_output(&existing));
        }
        let ids = delegation::DelegationIds::derive(&delegation::STEWARD, delegation_id);
        let now = (self.now)();
        let packet = packets::steward(&ids, &request, parent_chat_id, reviewed, (plan, review));
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
        let intent = DispatchIntent {
            envelope,
            metadata: DispatchMetadata {
                source: "btcc-subsession-delegation".into(),
            },
        };
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
        stored: &crate::btcc::StoredSubsessionDelegation,
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
        let metadata = child_metadata(role_name, &stored.packet, access, &parent);
        self.create_child_binding(stored, &parent, role, metadata)
            .await
    }
    async fn replay(
        &self,
        stored: &crate::btcc::StoredSubsessionDelegation,
    ) -> Result<(), BtccError> {
        let envelope =
            serde_json::to_value(&stored.dispatch_intent.envelope).map_err(|source| {
                error(BtccCode::SubsessionDispatchIntentInvalid).with_source(source)
            })?;
        self.queue.enqueue(SubsessionEnqueue {
            envelope,
            metadata: Map::new(),
        })?;
        self.repository
            .mark_enqueued(stored.relation_id.clone())
            .await
            .map_err(BtccError::from)
    }
}
