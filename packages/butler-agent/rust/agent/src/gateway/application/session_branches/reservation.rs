//! Transactional branch identity, project, and session reservation.

use std::path::PathBuf;

use rusqlite::{OptionalExtension, TransactionBehavior};
use tokio_util::sync::CancellationToken;

use super::{
    AppSessionBranchDestination, AppSessionBranchRequest, AppSessionBranchSeed,
    store::{self, BranchRow},
};
use crate::gateway::{
    AppChatKind, AppCreateSessionInput, AppEventEnvelope, GatewayApplicationError,
    application::{AppApplication, AppStorageError},
};

pub(super) enum SaveOutcome {
    Existing(BranchRow),
    Created(BranchRow, Option<AppEventEnvelope>),
}

impl AppApplication {
    pub(super) async fn reserve_branch(
        &self,
        request: AppSessionBranchRequest,
        digest: &str,
        seed: AppSessionBranchSeed,
        server_shutdown: &CancellationToken,
        owner_shutdown: &CancellationToken,
    ) -> Result<SaveOutcome, GatewayApplicationError> {
        let (project_name, scratch) = match &request.destination {
            AppSessionBranchDestination::NewProject { name } => {
                let name = super::super::projects::validate_branch_name(name)?;
                let root = self.project_creation.workspace_root();
                let scratch_name = name.clone();
                let made = tokio::task::spawn_blocking(move || {
                    super::super::projects::prepare_branch_scratch(&root, &scratch_name)
                })
                .await
                .map_err(|_| GatewayApplicationError::Internal)??;
                (Some(name), Some(made))
            }
            _ => (None, None),
        };
        let rollback_root = self.project_creation.workspace_root();
        if server_shutdown.is_cancelled() || owner_shutdown.is_cancelled() {
            if let Some(scratch) = &scratch {
                rollback_scratch(rollback_root, scratch.clone()).await;
            }
            return Err(cancelled());
        }

        let scratch_path = scratch.as_ref().map(|value| value.path.clone());
        let digest = digest.to_owned();
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let saved = self
            .storage
            .execute(move |db| {
                let tx = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(AppStorageError::sqlite)?;
                if let Some(row) = store::row(&tx, &request.request_id)? {
                    tx.commit().map_err(AppStorageError::sqlite)?;
                    return Ok(SaveOutcome::Existing(row));
                }
                let project = if let (Some(name), Some(path)) = (&project_name, &scratch_path) {
                    let project = super::super::projects::insert_branch_project(
                        &tx,
                        clock.as_ref(),
                        path,
                        name,
                    )?;
                    let event = super::super::projects::branch_project_created_event(
                        &tx,
                        clock.as_ref(),
                        &project,
                    )?;
                    Some((project, event))
                } else if let AppSessionBranchDestination::Project { project_id } =
                    &request.destination
                {
                    tx.query_row(
                        "SELECT id FROM projects WHERE id=?1 AND archived=0",
                        [project_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(AppStorageError::sqlite)?
                    .ok_or_else(|| {
                        AppStorageError::new("project_not_found", "Project not found.")
                    })?;
                    None
                } else {
                    None
                };
                let project_id =
                    project
                        .as_ref()
                        .map(|(value, _)| value.id.clone())
                        .or_else(|| match &request.destination {
                            AppSessionBranchDestination::Project { project_id } => {
                                Some(project_id.clone())
                            }
                            _ => None,
                        });
                let kind = if project_id.is_some() {
                    AppChatKind::Project
                } else {
                    AppChatKind::Chat
                };
                let session = super::super::sessions::create_branch_session(
                    &tx,
                    &subscribers,
                    &AppCreateSessionInput {
                        kind,
                        title: Some(request.title.clone()),
                        project_id,
                        session_hint: None,
                    },
                    clock.as_ref(),
                )?;
                store::insert(&tx, &request, &digest, &session.id, &seed)?;
                let row = store::row(&tx, &request.request_id)?.ok_or_else(|| {
                    AppStorageError::new(
                        "branch_reservation_lost",
                        "Branch reservation was not saved.",
                    )
                })?;
                let event = project.map(|(_, event)| event);
                tx.commit().map_err(AppStorageError::sqlite)?;
                Ok(SaveOutcome::Created(row, event))
            })
            .await;
        match saved {
            Ok(outcome @ SaveOutcome::Existing(_)) => {
                if let Some(scratch) = &scratch {
                    rollback_scratch(rollback_root, scratch.clone()).await;
                }
                Ok(outcome)
            }
            Ok(outcome) => Ok(outcome),
            Err(error) => {
                if let Some(scratch) = &scratch {
                    rollback_scratch(rollback_root, scratch.clone()).await;
                }
                Err(super::super::app_error(error))
            }
        }
    }
}

async fn rollback_scratch(root: PathBuf, scratch: super::super::projects::ScratchFolder) {
    let _ = tokio::task::spawn_blocking(move || {
        super::super::projects::rollback_branch_scratch(&root, &scratch);
    })
    .await;
}

fn cancelled() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "branch_cancelled".to_owned(),
        message: "새 대화 만들기가 취소되었습니다.".to_owned(),
    }
}
