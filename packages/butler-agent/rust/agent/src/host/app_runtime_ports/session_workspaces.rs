//! Source project-session worktree provisioning over the existing binding owner.

mod relocation;

use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::{
    btcc::NativeSubsessionService,
    conversation::AgentConversationStore,
    gateway::{
        AppSessionWorkspaceProvisioner, AppSessionWorkspaceSnapshot, ApplicationFuture,
        GatewayApplicationError,
    },
    workspace::{
        BindSessionWorktreeInput, BindSessionWorktreeResult, NativeSessionWorkspaceRecovery,
        NativeSessionWorktrees, OwnOptional, ProjectWorkspaceInspection, SessionBindingStore,
        SessionLifecycleState, SessionRole, SessionWorkspaceAuthority, SessionWorkspaceValidation,
        SessionWorktreeAction, UpsertSessionBinding, WorkspaceReference,
        short_session_worktree_branch,
    },
};

pub(crate) struct NativeAppSessionWorkspaces {
    bindings: SessionBindingStore,
    worktrees: NativeSessionWorktrees,
    recovery: NativeSessionWorkspaceRecovery,
    subsessions: Arc<NativeSubsessionService>,
    conversations: Arc<AgentConversationStore>,
}

impl NativeAppSessionWorkspaces {
    pub(crate) fn new(
        bindings: SessionBindingStore,
        worktrees: NativeSessionWorktrees,
        recovery: NativeSessionWorkspaceRecovery,
        subsessions: Arc<NativeSubsessionService>,
        conversations: Arc<AgentConversationStore>,
    ) -> Self {
        Self {
            bindings,
            worktrees,
            recovery,
            subsessions,
            conversations,
        }
    }
}

impl AppSessionWorkspaceProvisioner for NativeAppSessionWorkspaces {
    fn provision(
        &self,
        snapshot: AppSessionWorkspaceSnapshot,
        server_shutdown: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<()> {
        let bindings = self.bindings.clone();
        let worktrees = self.worktrees.clone();
        Box::pin(async move {
            if bindings
                .get_by_session_id(&snapshot.runtime_session_id)
                .await
                .map_err(|_| GatewayApplicationError::Internal)?
                .is_some()
            {
                return Err(provisioning_error());
            }
            let (provider, _) = snapshot
                .model
                .split_once('/')
                .ok_or_else(provisioning_error)?;
            let mut metadata = Map::<String, Value>::new();
            metadata.insert("source".into(), "app-project-session-creation".into());
            metadata.insert("appSessionKind".into(), "project".into());
            metadata.insert("accessMode".into(), snapshot.access_mode.into());
            metadata.insert("reasoning_effort".into(), snapshot.reasoning_effort.into());
            metadata.insert("plan_mode".into(), snapshot.plan_mode.into());
            bindings
                .upsert(UpsertSessionBinding {
                    session_id: snapshot.runtime_session_id.clone(),
                    role: SessionRole::Butler,
                    project_id: Some(snapshot.project_id.clone()),
                    app_project_id: OwnOptional::Value(snapshot.project_id),
                    ledger_project_id: snapshot
                        .ledger_project_id
                        .map_or(OwnOptional::Absent, OwnOptional::Value),
                    workspace_path: snapshot.workspace_path.clone(),
                    runtime_adapter_id: "btcc-turn-runtime".into(),
                    model_provider_id: if provider.is_empty() {
                        "openai"
                    } else {
                        provider
                    }
                    .into(),
                    model_ref: snapshot.model,
                    runtime_session_ref: None,
                    provider_thread_ref: None,
                    transport_bindings: Vec::new(),
                    lifecycle_state: Some(SessionLifecycleState::Active),
                    created_at: None,
                    updated_at: None,
                    last_active_at: None,
                    metadata: Some(metadata),
                })
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            let result = worktrees
                .bind(BindSessionWorktreeInput {
                    action: SessionWorktreeAction::Create,
                    branch: short_session_worktree_branch(&snapshot.session_id),
                    start_point: Some("HEAD".into()),
                    session_id: snapshot.runtime_session_id.clone(),
                    project_name: Some(snapshot.display_name),
                    workspace_reference: WorkspaceReference::new(Path::new(
                        &snapshot.workspace_path,
                    )),
                    abort: server_shutdown,
                })
                .await;
            // A failed bind clears the binding, then reports its outcome.
            let failed = match result {
                Ok(BindSessionWorktreeResult::Bound { .. }) => None,
                Ok(BindSessionWorktreeResult::Failed {
                    code: "git_not_installed" | "git_repository_required",
                    ..
                }) => Some(Ok(())),
                Ok(BindSessionWorktreeResult::Failed { .. }) => Some(Err(provisioning_error())),
                Err(_) => Some(Err(GatewayApplicationError::Internal)),
            };
            match failed {
                None => Ok(()),
                Some(outcome) => {
                    bindings
                        .delete_session(&snapshot.runtime_session_id)
                        .await
                        .map_err(|_| GatewayApplicationError::Internal)?;
                    outcome
                }
            }
        })
    }

    fn branch_info(
        &self,
        query: crate::gateway::AppSessionBranchQuery,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> ApplicationFuture<Value> {
        let recovery = self.recovery.clone();
        Box::pin(async move {
            let recovered = recovery
                .recover(
                    &query.runtime_session_id,
                    query.project_workspace_path.as_deref(),
                    cancellation.clone(),
                )
                .await
                .map_err(|_| GatewayApplicationError::Internal)?;
            let value = match recovered.authority {
                SessionWorkspaceAuthority::Unavailable {
                    workspace_label,
                    error_code,
                    ..
                } => serde_json::json!({
                    "available":false,"workspace_mode":"unknown",
                    "safe_status":"Session worktree unavailable",
                    "safe_error_code":error_code,"workspace_binding":"session_worktree",
                    "workspace_label":workspace_label,"workspace_status":"unavailable"
                }),
                SessionWorkspaceAuthority::SessionWorktree {
                    branch,
                    workspace_label,
                    ..
                } => match recovered.validation {
                    SessionWorkspaceValidation::Valid { dirty, .. } => serde_json::json!({
                        "available":true,"workspace_mode":"git","branch_name":branch,
                        "safe_status":format!("Git branch {branch}"),"workspace_binding":"session_worktree",
                        "workspace_label":workspace_label,"workspace_status":"available","dirty":dirty
                    }),
                    SessionWorkspaceValidation::Invalid { code } => serde_json::json!({
                        "available":false,"workspace_mode":"unknown",
                        "safe_status":if code == "git_not_installed" {"Git is not installed"} else {"Session worktree unavailable"},
                        "safe_error_code":if code == "git_not_installed" {code} else {"session_workspace_unavailable"},
                        "workspace_binding":"session_worktree","workspace_label":workspace_label,
                        "workspace_status":"unavailable"
                    }),
                },
                SessionWorkspaceAuthority::Project { .. } => {
                    let Some(path) = query.project_workspace_path.as_deref() else {
                        return Ok(serde_json::json!({
                            "available":false,"workspace_mode":"none","safe_status":"No project workspace"
                        }));
                    };
                    let label = safe_basename(path);
                    match recovery
                        .inspect_project(path, cancellation)
                        .await
                        .map_err(|_| GatewayApplicationError::Internal)?
                    {
                        ProjectWorkspaceInspection::Folder => serde_json::json!({
                            "available":false,"workspace_mode":"folder","safe_status":"Project workspace",
                            "workspace_binding":"project","workspace_label":label,"workspace_status":"available"
                        }),
                        ProjectWorkspaceInspection::Git { branch, dirty } => serde_json::json!({
                            "available":true,"workspace_mode":"git","branch_name":branch,
                            "safe_status":branch.as_ref().map(|name|format!("Git branch {name}")).unwrap_or_else(||"Detached HEAD".into()),
                            "workspace_binding":"project","workspace_label":label,
                            "workspace_status":"available","dirty":dirty
                        }),
                        ProjectWorkspaceInspection::Unavailable { code } => serde_json::json!({
                            "available":false,"workspace_mode":"unknown",
                            "safe_status":if code == "git_not_installed" {"Git is not installed"} else {"Git workspace unavailable"},
                            "safe_error_code":code,"workspace_binding":"project",
                            "workspace_label":label,"workspace_status":"unavailable"
                        }),
                    }
                }
            };
            Ok(value)
        })
    }
}

fn safe_basename(path: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Project");
    let name: String = name
        .chars()
        .filter(|character| {
            let code = *character as u32;
            code > 31 && code != 127
        })
        .take(80)
        .collect();
    if name.trim().is_empty() {
        "Project".into()
    } else {
        name
    }
}

fn provisioning_error() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "session_worktree_creation_failed".into(),
        message: "Project session worktree could not be created.".into(),
    }
}
