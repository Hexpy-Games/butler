//! Branch request resolution, context preparation, and readiness publication.

use rusqlite::TransactionBehavior;
use tokio_util::sync::CancellationToken;

use super::{
    AppSessionBranchRequest, AppSessionBranchResult, AppStartTopicConversationRequest,
    reservation::SaveOutcome,
    store::{self, BranchRow},
};
use crate::gateway::{
    AppChatKind, AppSessionBranchQuery, AppSessionWorkspaceSnapshot, GatewayApplicationError,
    application::{AppApplication, AppStorageError},
};

impl AppApplication {
    pub(super) async fn run_session_branch(
        &self,
        input: AppStartTopicConversationRequest,
        server_shutdown: CancellationToken,
        owner_shutdown: CancellationToken,
    ) -> Result<AppSessionBranchResult, GatewayApplicationError> {
        let (request, digest, existing) = self.resolve_request(input).await?;
        if let Some(row) = existing {
            if row.input_digest != digest {
                return Err(conflict());
            }
            return self
                .resume_branch(row, request, server_shutdown, owner_shutdown)
                .await;
        }

        let seed = self
            .prepare_seed(&request, &server_shutdown, &owner_shutdown)
            .await?;
        if server_shutdown.is_cancelled() || owner_shutdown.is_cancelled() {
            return Err(cancelled());
        }
        let saved = self
            .reserve_branch(
                request.clone(),
                &digest,
                seed,
                &server_shutdown,
                &owner_shutdown,
            )
            .await?;
        match saved {
            SaveOutcome::Existing(row) => {
                if row.input_digest != digest {
                    return Err(conflict());
                }
                self.resume_branch(row, request, server_shutdown, owner_shutdown)
                    .await
            }
            SaveOutcome::Created(row, project_event) => {
                if let Some(event) = project_event {
                    super::super::events::publish(&self.subscribers, &event);
                }
                self.resume_branch(row, request, server_shutdown, owner_shutdown)
                    .await
            }
        }
    }

    async fn resume_branch(
        &self,
        mut row: BranchRow,
        request: AppSessionBranchRequest,
        server_shutdown: CancellationToken,
        owner_shutdown: CancellationToken,
    ) -> Result<AppSessionBranchResult, GatewayApplicationError> {
        if row.state == "prepared" {
            let session = self.get_session(row.target_session_id.clone()).await?;
            if session.kind == AppChatKind::Project {
                self.provision_project_session(&session, &server_shutdown, &owner_shutdown)
                    .await?;
            }
            let session_id = row.target_session_id.clone();
            let request_id = request.request_id.clone();
            let clock = self.dependencies.identity_clock.clone();
            let subscribers = self.subscribers.clone();
            let event = self
                .storage
                .execute(move |db| {
                    let tx = db
                        .transaction_with_behavior(TransactionBehavior::Immediate)
                        .map_err(AppStorageError::sqlite)?;
                    let changed = store::mark_ready(&tx, &request_id)?;
                    let event = if changed {
                        Some(super::super::sessions::branch_session_created_event(
                            &tx,
                            &session_id,
                            clock.as_ref(),
                        )?)
                    } else {
                        None
                    };
                    tx.commit().map_err(AppStorageError::sqlite)?;
                    Ok(event)
                })
                .await
                .map_err(super::super::app_error)?;
            if let Some(event) = event {
                super::super::events::publish(&subscribers, &event);
            }
            row = self
                .storage
                .execute({
                    let request_id = request.request_id.clone();
                    move |db| {
                        store::row(db, &request_id)?.ok_or_else(|| {
                            AppStorageError::new(
                                "branch_reservation_lost",
                                "Branch reservation was not saved.",
                            )
                        })
                    }
                })
                .await
                .map_err(super::super::app_error)?;
        }
        let seed = store::seed(&row).map_err(super::super::app_error)?;
        let session = self.get_session(row.target_session_id).await?;
        Ok(AppSessionBranchResult { session, seed })
    }

    async fn provision_project_session(
        &self,
        session: &crate::gateway::AppSessionSummary,
        server_shutdown: &CancellationToken,
        owner_shutdown: &CancellationToken,
    ) -> Result<(), GatewayApplicationError> {
        if server_shutdown.is_cancelled() || owner_shutdown.is_cancelled() {
            return Err(cancelled());
        }
        let path = self
            .project_workspace_path(session.project_id.clone())
            .await?
            .ok_or(GatewayApplicationError::Internal)?;
        let runtime_session_id = session.session_hint.clone();
        let cancellation = CancellationToken::new();
        let info = self
            .dependencies
            .session_workspaces
            .branch_info(
                AppSessionBranchQuery {
                    runtime_session_id: runtime_session_id.clone(),
                    project_workspace_path: Some(path.clone()),
                },
                cancellation.clone(),
            )
            .await?;
        let expected_branch = crate::workspace::short_session_worktree_branch(&session.id);
        if info.get("available").and_then(serde_json::Value::as_bool) == Some(true)
            && info
                .get("workspace_binding")
                .and_then(serde_json::Value::as_str)
                == Some("session_worktree")
            && info.get("branch_name").and_then(serde_json::Value::as_str)
                == Some(expected_branch.as_str())
        {
            return Ok(());
        }
        let snapshot: AppSessionWorkspaceSnapshot = self.branch_workspace_snapshot(session).await?;
        let provision = self
            .dependencies
            .session_workspaces
            .provision(snapshot, cancellation.clone());
        tokio::pin!(provision);
        tokio::select! {
            result = &mut provision => result,
            () = server_shutdown.cancelled() => { cancellation.cancel(); provision.await }
            () = owner_shutdown.cancelled() => { cancellation.cancel(); provision.await }
        }
    }
}

fn conflict() -> GatewayApplicationError {
    public(
        409,
        "branch_identity_conflict",
        "같은 생성 요청의 내용이 변경되었습니다.",
    )
}

fn cancelled() -> GatewayApplicationError {
    public(409, "branch_cancelled", "새 대화 만들기가 취소되었습니다.")
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
