//! Adapter from the required Gateway relocation port to existing native owners.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::NativeAppSessionWorkspaces;
use crate::{
    btcc::NativeSubsessionService,
    gateway::{
        AppRelocationBinding, AppRelocationBindingResult, AppRelocationBindingSeed,
        AppRelocationBindingUpdate, AppRelocationCanonicalUpdate, AppRelocationHost,
        AppRelocationSnapshot, AppRelocationTransportBinding, AppRelocationWorkspaceMarker,
        AppRelocationWorkspacePlan, AppRelocationWorkspaceRequest, ApplicationFuture,
        GatewayApplicationError,
    },
    workspace::{
        ExecutionContextInput, OwnOptional, RebindWorkspaceResult, RelocationWorkspaceInput,
        RelocationWorkspaceMarker, RelocationWorkspacePlan, SessionLifecycleState, SessionRole,
        UpsertSessionBinding, WorkspaceError,
    },
};

impl AppRelocationHost for NativeAppSessionWorkspaces {
    fn inspect(&self, runtime_session_id: String) -> ApplicationFuture<AppRelocationSnapshot> {
        let bindings = self.bindings.clone();
        let subsessions = self.subsessions.clone();
        Box::pin(async move {
            let binding = bindings
                .get_by_session_id(&runtime_session_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?
                .as_ref()
                .map(to_app_binding);
            let active_execution = subsessions
                .has_unfinished_execution(&runtime_session_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            let open_child = has_open_child(&subsessions, runtime_session_id).await?;
            Ok(AppRelocationSnapshot {
                binding,
                active_execution,
                open_child,
            })
        })
    }

    fn ensure_binding(
        &self,
        seed: AppRelocationBindingSeed,
    ) -> ApplicationFuture<AppRelocationBinding> {
        let bindings = self.bindings.clone();
        Box::pin(async move {
            if let Some(binding) = bindings
                .get_by_session_id(&seed.runtime_session_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?
            {
                return Ok(to_app_binding(&binding));
            }
            let mut metadata = Map::new();
            metadata.insert(
                "appSessionKind".into(),
                Value::String(
                    if seed.project_id.is_some() {
                        "project"
                    } else {
                        "chat"
                    }
                    .into(),
                ),
            );
            metadata.insert(
                "source".into(),
                Value::String("app-session-relocation".into()),
            );
            let binding = bindings
                .upsert(UpsertSessionBinding {
                    session_id: seed.runtime_session_id,
                    role: SessionRole::Butler,
                    lifecycle_state: Some(SessionLifecycleState::Active),
                    project_id: seed.project_id.clone(),
                    app_project_id: seed
                        .project_id
                        .map_or(OwnOptional::Null, OwnOptional::Value),
                    ledger_project_id: seed
                        .ledger_project_id
                        .map_or(OwnOptional::Null, OwnOptional::Value),
                    workspace_path: seed.workspace_path,
                    runtime_adapter_id: "btcc-turn-runtime".into(),
                    model_provider_id: seed.model_provider_id,
                    model_ref: seed.model_ref,
                    runtime_session_ref: None,
                    provider_thread_ref: None,
                    transport_bindings: Vec::new(),
                    created_at: None,
                    updated_at: None,
                    last_active_at: None,
                    metadata: Some(metadata),
                })
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            Ok(to_app_binding(&binding))
        })
    }

    fn plan_workspace(
        &self,
        request: AppRelocationWorkspaceRequest,
    ) -> ApplicationFuture<AppRelocationWorkspacePlan> {
        let worktrees = self.worktrees.clone();
        Box::pin(async move {
            let plan = worktrees
                .plan_relocation(RelocationWorkspaceInput {
                    runtime_session_id: request.runtime_session_id,
                    operation_id: request.operation_id,
                    project_path: request.project_path,
                    project_name: request.project_name,
                })
                .await
                .map_err(relocation_error)?;
            Ok(to_app_plan(plan))
        })
    }

    fn prepare_workspace(
        &self,
        plan: AppRelocationWorkspacePlan,
    ) -> ApplicationFuture<AppRelocationWorkspacePlan> {
        let worktrees = self.worktrees.clone();
        Box::pin(async move {
            let prepared = worktrees
                .prepare_relocation(from_app_plan(plan))
                .await
                .map_err(relocation_error)?;
            Ok(to_app_plan(prepared))
        })
    }

    fn compare_and_set_binding(
        &self,
        input: AppRelocationBindingUpdate,
    ) -> ApplicationFuture<AppRelocationBindingResult> {
        let bindings = self.bindings.clone();
        Box::pin(async move {
            let result = bindings
                .compare_and_set_execution_context(ExecutionContextInput {
                    session_id: input.runtime_session_id,
                    expected_updated_at: input.expected_updated_at,
                    operation_id: input.operation_id,
                    workspace_path: input.workspace_path,
                    project_id: input.project_id,
                    app_project_id: input.app_project_id,
                    ledger_project_id: input.ledger_project_id,
                    metadata: input.metadata,
                })
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            Ok(match result {
                RebindWorkspaceResult::Applied(_) => AppRelocationBindingResult::Applied,
                RebindWorkspaceResult::Changed(_) => AppRelocationBindingResult::Changed,
                RebindWorkspaceResult::Missing => AppRelocationBindingResult::Missing,
            })
        })
    }

    fn sync_conversation_context(
        &self,
        input: AppRelocationCanonicalUpdate,
    ) -> ApplicationFuture<()> {
        let conversations = self.conversations.clone();
        Box::pin(async move {
            let canonical = conversations
                .get_session_by_gateway_binding("app", &input.runtime_session_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            if let Some(canonical) = canonical {
                conversations
                    .sync_session_context(&canonical.id, input.project_id, &input.revision)
                    .await
                    .map_err(|_| GatewayApplicationError::Internal)?;
            }
            Ok(())
        })
    }

    fn discard_workspace(&self, plan: AppRelocationWorkspacePlan) -> ApplicationFuture<bool> {
        let worktrees = self.worktrees.clone();
        Box::pin(async move {
            worktrees
                .discard_relocation(from_app_plan(plan))
                .await
                .map_err(relocation_error)
        })
    }
}

async fn has_open_child(
    subsessions: &NativeSubsessionService,
    root: String,
) -> Result<bool, GatewayApplicationError> {
    let repository = subsessions.repository();
    let mut pending = vec![root];
    let mut seen = HashSet::new();
    while let Some(session_id) = pending.pop() {
        if !seen.insert(session_id.clone()) {
            return Ok(true);
        }
        if repository
            .has_active_child(session_id.clone())
            .await
            .map_err(|_| GatewayApplicationError::Internal)?
        {
            return Ok(true);
        }
        let relations = repository
            .relations_for_parent(session_id)
            .await
            .map_err(|_| GatewayApplicationError::Internal)?;
        pending.extend(
            relations
                .into_iter()
                .map(|relation| relation.child_session_id),
        );
    }
    Ok(false)
}

fn to_app_binding(binding: &crate::workspace::StoredSessionBinding) -> AppRelocationBinding {
    AppRelocationBinding {
        session_id: binding.session_id.clone(),
        role: match &binding.role {
            SessionRole::Butler => "butler".into(),
            SessionRole::Steward => "steward".into(),
            SessionRole::Worker => "worker".into(),
            SessionRole::Unknown(value) => value.clone(),
        },
        lifecycle_state: match &binding.lifecycle_state {
            SessionLifecycleState::Active => "active".into(),
            SessionLifecycleState::Closing => "closing".into(),
            SessionLifecycleState::Closed => "closed".into(),
            SessionLifecycleState::Crashed => "crashed".into(),
            SessionLifecycleState::Unknown(value) => value.clone(),
        },
        project_id: binding.project_id.clone(),
        app_project_id: binding.app_project_id.clone(),
        ledger_project_id: binding.ledger_project_id.clone(),
        workspace_path: binding.workspace_path.clone(),
        runtime_adapter_id: binding.runtime_adapter_id.clone(),
        model_provider_id: binding.model_provider_id.clone(),
        model_ref: binding.model_ref.clone(),
        runtime_session_ref: binding.runtime_session_ref.clone(),
        provider_thread_ref: binding.provider_thread_ref.clone(),
        transport_bindings: binding
            .transport_bindings
            .iter()
            .map(|value| AppRelocationTransportBinding {
                transport: value.transport.clone(),
                account_id: value.account_id.clone(),
                peer_id: value.peer_id.clone(),
                thread_id: value.thread_id.clone(),
            })
            .collect(),
        created_at: binding.created_at.clone(),
        updated_at: binding.updated_at.clone(),
        last_active_at: binding.last_active_at.clone(),
        metadata: binding.metadata.clone(),
    }
}

fn to_app_plan(plan: RelocationWorkspacePlan) -> AppRelocationWorkspacePlan {
    AppRelocationWorkspacePlan {
        runtime_session_id: plan.runtime_session_id,
        operation_id: plan.operation_id,
        workspace_path: plan.workspace_path,
        marker: plan.marker.map(|marker| AppRelocationWorkspaceMarker {
            schema: marker.schema,
            ownership: marker.ownership,
            repository_anchor_path: marker.repository_anchor_path,
            branch: marker.branch,
            bound_at: marker.bound_at,
        }),
        created: plan.created,
    }
}

fn from_app_plan(plan: AppRelocationWorkspacePlan) -> RelocationWorkspacePlan {
    RelocationWorkspacePlan {
        runtime_session_id: plan.runtime_session_id,
        operation_id: plan.operation_id,
        workspace_path: plan.workspace_path,
        marker: plan.marker.map(|marker| RelocationWorkspaceMarker {
            schema: marker.schema,
            ownership: marker.ownership,
            repository_anchor_path: marker.repository_anchor_path,
            branch: marker.branch,
            bound_at: marker.bound_at,
        }),
        created: plan.created,
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn relocation_error(error: WorkspaceError) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: error.code().into(),
        message: "대화의 작업공간을 이동할 수 없습니다.".into(),
    }
}
