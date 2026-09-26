use rusqlite::{Connection, params};
use serde::Deserialize;
use serde::Serialize;

use super::{AppApplication, AppProjectSummary, rows};
use crate::gateway::GatewayApplicationError;
use crate::gateway::application::{app_error, events, storage::AppStorageError};
use crate::public_text::trim_js_whitespace;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct AppProjectUpdate {
    pub display_name: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AppProjectActionResult {
    pub project: AppProjectSummary,
}

impl AppApplication {
    pub(crate) async fn update_project_owned(
        &self,
        project_id: String,
        input: AppProjectUpdate,
    ) -> Result<AppProjectActionResult, GatewayApplicationError> {
        if input.archived == Some(true) {
            return self
                .project_lifecycle(
                    project_id,
                    ProjectLifecycle::Archive,
                    input.display_name,
                    input.pinned,
                )
                .await;
        }
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| update_project(db, &subscribers, &project_id, input, clock.as_ref()))
            .await
            .map_err(app_error)
    }

    pub(crate) async fn archive_project_owned(
        &self,
        project_id: String,
    ) -> Result<AppProjectActionResult, GatewayApplicationError> {
        self.project_lifecycle(project_id, ProjectLifecycle::Archive, None, None)
            .await
    }

    pub(crate) async fn pin_project_owned(
        &self,
        project_id: String,
        pinned: Option<bool>,
    ) -> Result<AppProjectActionResult, GatewayApplicationError> {
        let current_id = project_id.clone();
        let current = self
            .storage
            .execute(move |db| rows::active_by_id(db, &current_id))
            .await
            .map_err(app_error)?
            .ok_or_else(|| public(404, "project_not_found", "Project not found."))?;
        let input = AppProjectUpdate {
            display_name: None,
            pinned: Some(pinned.unwrap_or(!current.pinned)),
            archived: None,
        };
        self.update_project_owned(project_id, input).await
    }

    pub(crate) async fn delete_project_owned(
        &self,
        project_id: String,
        permanent: bool,
    ) -> Result<AppProjectActionResult, GatewayApplicationError> {
        self.project_lifecycle(
            project_id,
            if permanent {
                ProjectLifecycle::PermanentDelete
            } else {
                ProjectLifecycle::Delete
            },
            None,
            None,
        )
        .await
    }

    async fn project_lifecycle(
        &self,
        project_id: String,
        action: ProjectLifecycle,
        display_name: Option<String>,
        pinned: Option<bool>,
    ) -> Result<AppProjectActionResult, GatewayApplicationError> {
        let query_id = project_id.clone();
        let sessions = self
            .storage
            .execute(move |db| project_session_ids(db, &query_id))
            .await
            .map_err(app_error)?;
        for session_id in sessions {
            let runtime_session_id = crate::gateway::app_session_hint(&session_id);
            self.dependencies
                .authority_handoff
                .close_self_session(
                    runtime_session_id,
                    if action == ProjectLifecycle::PermanentDelete {
                        "session_permanently_deleted"
                    } else {
                        "session_archived"
                    }
                    .to_owned(),
                )
                .await?;
        }
        let clock = self.dependencies.identity_clock.clone();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                lifecycle_project(
                    db,
                    &subscribers,
                    &project_id,
                    action,
                    display_name.as_deref(),
                    pinned,
                    clock.as_ref(),
                )
            })
            .await
            .map_err(app_error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectLifecycle {
    Archive,
    Delete,
    PermanentDelete,
}

fn project_session_ids(db: &Connection, project_id: &str) -> Result<Vec<String>, AppStorageError> {
    let mut statement = db
        .prepare(
            "SELECT c.id FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.project_id=? ORDER BY c.created_at ASC,c.rowid ASC",
        )
        .map_err(AppStorageError::sqlite)?;
    statement
        .query_map([project_id], |row| row.get(0))
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)
}

fn update_project(
    db: &mut Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    project_id: &str,
    input: AppProjectUpdate,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppProjectActionResult, AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    let row = rows::any_by_id(&tx, project_id)?
        .ok_or_else(|| AppStorageError::new("project_not_found", "Project not found."))?;
    let display_name = input
        .display_name
        .as_deref()
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .unwrap_or(&row.display_name);
    let pinned = input.pinned.map_or(row.pinned, |value| value);
    let archived = input.archived.map_or(row.archived, |value| value);
    let status = match input.archived {
        Some(true) => "archived",
        Some(false) => "active",
        None => row.status.as_str(),
    };
    tx.execute(
        "UPDATE projects SET display_name=?1,pinned=?2,archived=?3,status=?4,updated_at=?5 WHERE id=?6",
        params![display_name,i64::from(pinned),i64::from(archived),status,clock.now_iso(),project_id],
    )
    .map_err(AppStorageError::sqlite)?;
    let project = read_project(&tx, project_id)?;
    let event = append_project_event(&tx, "project.updated", &project, clock)?;
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, event);
    Ok(AppProjectActionResult { project })
}

fn lifecycle_project(
    db: &mut Connection,
    subscribers: &crate::gateway::application::events::EventSubscribers,
    project_id: &str,
    action: ProjectLifecycle,
    display_name: Option<&str>,
    pinned: Option<bool>,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<AppProjectActionResult, AppStorageError> {
    let tx = db.transaction().map_err(AppStorageError::sqlite)?;
    let row = rows::any_by_id(&tx, project_id)?
        .ok_or_else(|| AppStorageError::new("project_not_found", "Project not found."))?;
    if action == ProjectLifecycle::PermanentDelete {
        let project = rows::summary(row, None);
        tx.execute("DELETE FROM chats WHERE project_id=?", [project_id])
            .map_err(AppStorageError::sqlite)?;
        tx.execute("DELETE FROM projects WHERE id=?", [project_id])
            .map_err(AppStorageError::sqlite)?;
        let event = append_project_event(&tx, "project.permanently_deleted", &project, clock)?;
        tx.commit().map_err(AppStorageError::sqlite)?;
        events::publish(subscribers, event);
        return Ok(AppProjectActionResult { project });
    }
    let display_name = display_name
        .map(trim_js_whitespace)
        .filter(|name| !name.is_empty())
        .unwrap_or(&row.display_name);
    let pinned = pinned.unwrap_or(row.pinned);
    tx.execute(
        "UPDATE projects SET display_name=?1,pinned=?2,archived=1,status='archived',updated_at=?3 WHERE id=?4",
        params![display_name,i64::from(pinned),clock.now_iso(),project_id],
    )
    .map_err(AppStorageError::sqlite)?;
    let project = read_project(&tx, project_id)?;
    let updated_event = append_project_event(&tx, "project.updated", &project, clock)?;
    tx.execute(
        "UPDATE chats SET archived=1,updated_at=?1 WHERE project_id=?2",
        params![clock.now_iso(), project_id],
    )
    .map_err(AppStorageError::sqlite)?;
    let deleted_event = if action == ProjectLifecycle::Delete {
        Some(append_project_event(
            &tx,
            "project.deleted",
            &project,
            clock,
        )?)
    } else {
        None
    };
    tx.commit().map_err(AppStorageError::sqlite)?;
    events::publish(subscribers, updated_event);
    if let Some(event) = deleted_event {
        events::publish(subscribers, event);
    }
    Ok(AppProjectActionResult { project })
}

fn read_project(db: &Connection, id: &str) -> Result<AppProjectSummary, AppStorageError> {
    rows::any_by_id(db, id)?
        .map(|row| rows::summary(row, None))
        .ok_or_else(|| AppStorageError::new("project_not_found", "Project not found."))
}

fn append_project_event(
    db: &Connection,
    event_type: &str,
    project: &AppProjectSummary,
    clock: &dyn crate::gateway::application::AppIdentityClock,
) -> Result<crate::gateway::AppEventEnvelope, AppStorageError> {
    events::append_unpublished(
        db,
        event_type,
        None,
        crate::json::json_object!({"project":project}),
        &clock.now_iso(),
    )
}

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}
