//! App project creation and listing on the existing App SQLite and folder owners.

mod contracts;
mod dashboard;
mod folder;
mod mutations;
mod owner;
mod rows;
mod token;

pub(crate) use contracts::{
    AppCreateProjectRequest, AppCreateProjectResult, AppProjectList, AppProjectSource,
    AppProjectSummary,
};
pub(super) use dashboard::ProjectDashboardBriefingOwner;
pub(crate) use dashboard::{
    AppProjectDashboardActionProgress, AppProjectDashboardBriefingPort,
    AppProjectDashboardBriefingPrompt, AppProjectDashboardBriefingRequest,
    AppProjectDashboardCheckpoint, AppProjectDashboardDisposition, AppProjectDashboardLedgerError,
    AppProjectDashboardLedgerEvent, AppProjectDashboardLedgerFuture,
    AppProjectDashboardLedgerHistory, AppProjectDashboardLedgerPort,
    AppProjectDashboardLedgerRecord, AppProjectDashboardManagedPlan,
    AppProjectDashboardManagedWork, AppProjectDashboardPageQuery, AppProjectDashboardPinRef,
    AppProjectDashboardPreferencesUpdate, AppProjectDashboardRecordsQuery,
    AppProjectDashboardReview, AppProjectDashboardSnapshot, AppProjectDashboardSource,
    AppProjectDashboardSourceQuery, AppProjectDashboardStatisticsQuery, AppProjectDashboardWork,
    AppProjectDashboardWorkHistoryEntry,
};
#[cfg(test)]
pub(crate) use dashboard::{TestProjectDashboardBriefing, TestProjectDashboardLedger};
pub(crate) use mutations::{AppProjectActionResult, AppProjectUpdate};
pub(super) use owner::ProjectCreationOwner;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use super::{AppApplication, AppSessionSummary, AppStorageError, app_error};
use crate::gateway::application::AppIdentityClock;
use crate::gateway::{AppEventEnvelope, GatewayApplicationError};

pub(super) use folder::ScratchFolder;

pub(super) fn validate_branch_name(value: &str) -> Result<String, GatewayApplicationError> {
    folder::validate_name(Some(value))
}

pub(super) fn prepare_branch_scratch(
    root: &Path,
    name: &str,
) -> Result<ScratchFolder, GatewayApplicationError> {
    folder::create_scratch(root, name)
}

pub(super) fn rollback_branch_scratch(root: &Path, scratch: &ScratchFolder) {
    folder::rollback(root, scratch);
}

pub(super) fn insert_branch_project(
    db: &Connection,
    clock: &dyn AppIdentityClock,
    workspace: &Path,
    name: &str,
) -> Result<AppProjectSummary, AppStorageError> {
    rows::insert_scratch(db, clock, workspace, name)
}

pub(super) fn branch_project_created_event(
    db: &Connection,
    clock: &dyn AppIdentityClock,
    project: &AppProjectSummary,
) -> Result<AppEventEnvelope, AppStorageError> {
    rows::append_created_unpublished(db, clock, project)
}

pub(super) fn initial_root(db: &Connection, fallback: &Path) -> Result<PathBuf, AppStorageError> {
    let encoded: Option<String> = db
        .query_row(
            "SELECT value_json FROM app_settings WHERE key='default-project-workspace-root'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(AppStorageError::sqlite)?;
    let stored = encoded
        .as_deref()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty());
    let path = stored
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf());
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| {
                AppStorageError::new("project_workspace_unavailable", error.to_string())
            })
    }
}

impl AppApplication {
    pub(super) async fn archived_projects_owned(
        &self,
    ) -> Result<Vec<(String, AppProjectSummary)>, GatewayApplicationError> {
        self.storage
            .execute(|db| rows::archives(db))
            .await
            .map_err(app_error)
    }

    pub(crate) async fn create_project_owned(
        &self,
        request: AppCreateProjectRequest,
    ) -> Result<AppCreateProjectResult, GatewayApplicationError> {
        self.project_creation
            .create(self.clone_handle(), request)
            .await
    }

    async fn create_project_transaction(
        &self,
        request: AppCreateProjectRequest,
        root: PathBuf,
        secret: Option<String>,
    ) -> Result<AppCreateProjectResult, GatewayApplicationError> {
        let source = request.source;
        let display_name = if source == AppProjectSource::Scratch {
            Some(folder::validate_name(request.display_name.as_deref())?)
        } else {
            request.display_name
        };
        let token = request.folder_selection_token;
        let prepared = tokio::task::spawn_blocking({
            let root = root.clone();
            move || match source {
                AppProjectSource::Scratch => {
                    let scratch = folder::create_scratch(
                        &root,
                        display_name.as_deref().expect("validated scratch name"),
                    )?;
                    Ok((scratch.path.clone(), Some(scratch), display_name))
                }
                AppProjectSource::ExistingFolder => {
                    let token = token
                        .as_deref()
                        .filter(|value| !crate::public_text::trim_js_whitespace(value).is_empty())
                        .ok_or_else(|| {
                            error(
                                400,
                                "folder_selection_required",
                                "Project folder selection is required.",
                            )
                        })?;
                    let path = token::selected_path(token, secret.as_deref())?;
                    folder::validate_existing(Path::new(&path))
                        .map(|path| (path, None, display_name))
                }
            }
        })
        .await
        .map_err(|_| GatewayApplicationError::Internal)??;
        let (workspace, scratch, display_name) = prepared;
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        let saved = self
            .storage
            .execute({
                let workspace = workspace.clone();
                move |db| {
                    rows::create_or_reuse(
                        db,
                        &subscribers,
                        clock.as_ref(),
                        &workspace,
                        display_name.as_deref(),
                        source,
                    )
                }
            })
            .await;
        let (project, created, event_error) = match saved {
            Ok(value) => value,
            Err(error) => {
                if let Some(scratch) = scratch {
                    let _ = tokio::task::spawn_blocking(move || folder::rollback(&root, &scratch))
                        .await;
                }
                return Err(app_error(error));
            }
        };
        if !created {
            if let Some(scratch) = scratch {
                let _ =
                    tokio::task::spawn_blocking(move || folder::rollback(&root, &scratch)).await;
            }
            return Ok(AppCreateProjectResult { project });
        }
        if let Some(error) = event_error {
            return Err(app_error(error));
        }
        Ok(AppCreateProjectResult { project })
    }

    pub(crate) async fn list_projects(
        &self,
        include_sessions: bool,
    ) -> Result<AppProjectList, GatewayApplicationError> {
        let rows = self
            .storage
            .execute(|db| rows::list(db))
            .await
            .map_err(app_error)?;
        let mut sessions_by_project: HashMap<String, Vec<AppSessionSummary>> = HashMap::new();
        if include_sessions {
            for session in self.list_sessions(Some("project".to_owned()), None).await? {
                if let Some(project_id) = session.project_id.clone() {
                    sessions_by_project
                        .entry(project_id)
                        .or_default()
                        .push(session);
                }
            }
        }
        let projects = rows
            .into_iter()
            .map(|row| {
                let project_sessions = include_sessions.then(|| {
                    sessions_by_project
                        .remove(rows::id(&row))
                        .unwrap_or_default()
                });
                rows::summary(row, project_sessions)
            })
            .collect();
        Ok(AppProjectList { projects })
    }
}

fn error(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
