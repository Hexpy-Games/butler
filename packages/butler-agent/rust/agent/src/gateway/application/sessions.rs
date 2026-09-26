//! App-owned session rows and source-shaped navigation reads.

mod contracts;
mod mutations;
mod owner;
mod read;
mod write;

#[cfg(test)]
mod tests;

pub(crate) use contracts::{
    AppChatKind, AppChatSummary, AppCreateSessionInput, AppCreateSessionRequest,
    AppCreateSessionResult, AppSessionBranchQuery, AppSessionSummary, AppSessionWorkProgress,
    AppSessionWorkspaceProvisioner, AppSessionWorkspaceSnapshot, AppWorkProgress,
    AppWorkStreamQuery, AppWorkStreamReader, AppWorkStreamTurnOutcome, AppWorkspaceMode,
};
pub(crate) use mutations::{AppSessionActionResult, AppSessionUpdate};
pub(super) use owner::SessionCreationOwner;

use super::events::EventSubscribers;
use super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;

pub(super) fn create_branch_session(
    db: &Connection,
    subscribers: &EventSubscribers,
    input: AppCreateSessionInput,
    clock: &dyn super::AppIdentityClock,
) -> Result<AppSessionSummary, AppStorageError> {
    write::create(db, subscribers, input, clock, false)
}

pub(super) fn branch_session_created_event(
    db: &Connection,
    id: &str,
    clock: &dyn super::AppIdentityClock,
) -> Result<crate::gateway::AppEventEnvelope, AppStorageError> {
    write::append_created_unpublished(db, id, clock)
}

pub(super) fn read_summary(
    db: &Connection,
    session_id: &str,
) -> Result<AppSessionSummary, AppStorageError> {
    read::session(db, session_id)
}

impl AppApplication {
    pub(super) async fn archive_sessions_owned(
        &self,
    ) -> Result<Vec<(String, AppSessionSummary)>, GatewayApplicationError> {
        self.storage
            .execute(read::archives)
            .await
            .map_err(app_error)
    }

    pub(super) async fn project_workspace_path(
        &self,
        project_id: Option<String>,
    ) -> Result<Option<String>, GatewayApplicationError> {
        let Some(project_id) = project_id else {
            return Ok(None);
        };
        self.storage
            .execute(move |db| {
                read::workspace_project(db, &project_id).map(|row| row.workspace_path)
            })
            .await
            .map(Some)
            .map_err(app_error)
    }

    pub(crate) async fn create_session_owned(
        &self,
        request: AppCreateSessionRequest,
        server_shutdown: CancellationToken,
    ) -> Result<AppCreateSessionResult, GatewayApplicationError> {
        self.session_creation
            .create(self.clone_handle(), request, server_shutdown)
            .await
    }

    async fn create_session_transaction(
        &self,
        request: AppCreateSessionRequest,
        server_shutdown: CancellationToken,
        owner_shutdown: CancellationToken,
    ) -> Result<AppCreateSessionResult, GatewayApplicationError> {
        let created = self.create_session(request.input, false).await?;
        if request.workspace_mode == AppWorkspaceMode::Worktree {
            let provision = async {
                let snapshot = self.workspace_snapshot(&created).await?;
                let cancellation = server_shutdown.child_token();
                let future = self
                    .dependencies
                    .session_workspaces
                    .provision(snapshot, cancellation.clone());
                tokio::pin!(future);
                tokio::select! {
                    result = &mut future => result,
                    () = owner_shutdown.cancelled() => {
                        cancellation.cancel();
                        future.await
                    }
                }
            }
            .await;
            if let Err(error) = provision {
                self.rollback_session_creation(created.id.clone()).await?;
                return Err(error);
            }
        }
        self.publish_session_created(created.id.clone()).await?;
        Ok(AppCreateSessionResult { session: created })
    }

    async fn workspace_snapshot(
        &self,
        created: &AppSessionSummary,
    ) -> Result<AppSessionWorkspaceSnapshot, GatewayApplicationError> {
        let project_id = created
            .project_id
            .clone()
            .ok_or(GatewayApplicationError::Internal)?;
        let session_id = created.id.clone();
        let runtime_session_id = created.session_hint.clone();
        let facts = self.dependencies.settings_facts.snapshot()?;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                let project = read::workspace_project(db, &project_id)?;
                let settings = super::settings::session_workspace_settings(
                    db,
                    &subscribers,
                    &facts,
                    &clock.now_iso(),
                )?;
                Ok(AppSessionWorkspaceSnapshot {
                    session_id,
                    runtime_session_id,
                    project_id: project.id,
                    display_name: project.display_name,
                    workspace_path: project.workspace_path,
                    ledger_project_id: project.ledger_project_id,
                    model: settings.model,
                    reasoning_effort: settings.reasoning_effort,
                    access_mode: settings.access_mode,
                    plan_mode: settings.plan_mode,
                })
            })
            .await
            .map_err(app_error)
    }

    pub(super) async fn branch_workspace_snapshot(
        &self,
        created: &AppSessionSummary,
    ) -> Result<AppSessionWorkspaceSnapshot, GatewayApplicationError> {
        self.workspace_snapshot(created).await
    }
    pub(crate) async fn create_session(
        &self,
        input: AppCreateSessionInput,
        emit_created: bool,
    ) -> Result<AppSessionSummary, GatewayApplicationError> {
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| write::create(db, &subscribers, input, clock.as_ref(), emit_created))
            .await
            .map_err(app_error)
    }

    pub(crate) async fn publish_session_created(
        &self,
        id: String,
    ) -> Result<(), GatewayApplicationError> {
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| write::publish(db, &subscribers, &id, clock.as_ref()))
            .await
            .map_err(app_error)
    }

    pub(crate) async fn rollback_session_creation(
        &self,
        id: String,
    ) -> Result<(), GatewayApplicationError> {
        self.storage
            .execute(move |db| write::rollback(db, &id))
            .await
            .map_err(app_error)
    }

    pub(crate) async fn get_session(
        &self,
        id: String,
    ) -> Result<AppSessionSummary, GatewayApplicationError> {
        let mut session = self
            .storage
            .execute(move |db| read::session(db, &id))
            .await
            .map_err(app_error)?;
        session.skills_used = self
            .dependencies
            .skills
            .loaded_names(vec![(
                session.session_hint.clone(),
                session.latest_turn_id.clone(),
                Some(session.id.clone()),
            )])
            .await
            .map_err(super::skill_error)?
            .pop()
            .unwrap_or_default();
        Ok(session)
    }

    pub(crate) async fn list_chats(&self) -> Result<Vec<AppChatSummary>, GatewayApplicationError> {
        self.storage.execute(read::chats).await.map_err(app_error)
    }

    /// Source Work progress is projected by the required external Steward reader.
    pub(crate) async fn list_sessions(
        &self,
        kind: Option<String>,
        project_id: Option<String>,
    ) -> Result<Vec<AppSessionSummary>, GatewayApplicationError> {
        let mut sessions = self
            .storage
            .execute(move |db| read::sessions(db, kind.as_deref(), project_id.as_deref()))
            .await
            .map_err(app_error)?;
        let loaded = self
            .dependencies
            .skills
            .loaded_names(
                sessions
                    .iter()
                    .map(|session| {
                        (
                            session.session_hint.clone(),
                            session.latest_turn_id.clone(),
                            Some(session.id.clone()),
                        )
                    })
                    .collect(),
            )
            .await
            .map_err(super::skill_error)?;
        for (session, names) in sessions.iter_mut().zip(loaded) {
            session.skills_used = names;
        }
        for session in &mut sessions {
            if !matches!(
                session.active_turn_state.as_deref(),
                Some(state) if !matches!(state, "delivered" | "cancelled" | "failed" | "runtime_fault")
            ) {
                continue;
            }
            session.work_progress = self
                .dependencies
                .session_work_progress
                .read(session.session_hint.clone())
                .await?;
        }
        Ok(sessions)
    }
}

fn json_error(error: serde_json::Error) -> AppStorageError {
    AppStorageError::new("app_session_json_invalid", error.to_string())
}
