//! Revision-checked project dashboard description and source pins.

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::{
    AppProjectDashboardPreferencesUpdate, AppProjectDashboardSourceQuery, invalid_request,
    preferences_changed,
};
use super::project::{pins, read_project};
use crate::gateway::application::events;

const PIN_KINDS: &[&str] = &["work", "task", "plan", "spec", "report", "artifact"];

pub(super) async fn update(
    application: &AppApplication,
    project_id: &str,
    update: AppProjectDashboardPreferencesUpdate,
) -> Result<Value, GatewayApplicationError> {
    if update.expected_revision > i64::MAX as u64
        || (update.description.is_none() && update.pinned_source_refs.is_none())
        || update
            .description
            .as_ref()
            .is_some_and(|value| value.encode_utf16().count() > 2_000)
    {
        return Err(invalid_request());
    }
    let project = read_project(application, project_id).await?;
    if project.preferences_revision != update.expected_revision {
        return Err(preferences_changed());
    }
    let current_pins = pins(&project).map_err(app_error)?;
    let mut resolved = None;
    if let Some(requested) = update.pinned_source_refs.as_ref() {
        if requested.len() > 12 {
            return Err(invalid_request());
        }
        let mut unique = std::collections::HashSet::new();
        let mut normalized = Vec::with_capacity(requested.len());
        for pin in requested {
            if !PIN_KINDS.contains(&pin.kind.as_str())
                || pin.id.is_empty()
                || pin.id.encode_utf16().count() > 256
                || !is_digest(&pin.revision)
                || !unique.insert((pin.kind.clone(), pin.id.clone()))
            {
                return Err(invalid_request());
            }
            let retained = current_pins.iter().any(|current| {
                current.get("kind").and_then(Value::as_str) == Some(&pin.kind)
                    && current.get("id").and_then(Value::as_str) == Some(&pin.id)
                    && current.get("revision").and_then(Value::as_str) == Some(&pin.revision)
            });
            let revision = if retained {
                pin.revision.clone()
            } else {
                let source = super::source::get(
                    application,
                    &project.id,
                    AppProjectDashboardSourceQuery {
                        kind: pin.kind.clone(),
                        id: pin.id.clone(),
                        revision: pin.revision.clone(),
                        cursor: None,
                    },
                )
                .await?;
                let revision = source
                    .get("revision")
                    .and_then(Value::as_str)
                    .filter(|revision| is_digest(revision))
                    .ok_or_else(invalid_request)?;
                revision.to_owned()
            };
            normalized.push(json!({
                "kind":pin.kind,
                "id":pin.id,
                "revision":revision,
            }));
        }
        resolved = Some(normalized);
    }
    let mut preferences = super::project::preferences(&project).map_err(app_error)?;
    if let Some(pins) = resolved {
        preferences["pinnedSourceRefs"] = Value::Array(pins);
    }
    let preferences_json =
        serde_json::to_string(&preferences).map_err(|error| GatewayApplicationError::Public {
            status: 500,
            code: "app_project_preferences_invalid".into(),
            message: error.to_string(),
        })?;
    let description = update.description.or(project.description);
    let project_key = project.id.clone();
    let expected = update.expected_revision;
    let clock = application.dependencies.identity_clock.clone();
    let subscribers = application.subscribers.clone();
    let revision = application
        .storage
        .execute(move |db| {
            let tx = db.transaction().map_err(AppStorageError::sqlite)?;
            let current: Option<i64> = tx
                .query_row(
                    "SELECT dashboard_preferences_revision FROM projects WHERE id=?1",
                    [&project_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(AppStorageError::sqlite)?;
            if current.map(|value| value.max(0) as u64) != Some(expected) {
                return Err(AppStorageError::new(
                    "preferences_changed",
                    "Preferences changed. Reload them.",
                ));
            }
            tx.execute(
                "UPDATE projects SET description=?1,dashboard_preferences_json=?2,\
                 dashboard_preferences_revision=?3 WHERE id=?4 AND dashboard_preferences_revision=?5",
                params![description, preferences_json, (expected + 1) as i64, project_key, expected as i64],
            )
            .map_err(AppStorageError::sqlite)?;
            let row = super::super::rows::any_by_id(&tx, &project_key)?
                .ok_or_else(|| AppStorageError::new("project_not_found", "Project not found."))?;
            let project = super::super::rows::summary(row, None);
            let payload = json!({"project":project})
                .as_object()
                .cloned()
                .expect("project update event is an object");
            let event = events::append_unpublished(
                &tx,
                "project.updated",
                None,
                payload,
                &clock.now_iso(),
            )?;
            tx.commit().map_err(AppStorageError::sqlite)?;
            events::publish(&subscribers, event);
            Ok(expected + 1)
        })
        .await
        .map_err(|error| {
            if error.code() == "preferences_changed" {
                preferences_changed()
            } else {
                app_error(error)
            }
        })?;
    Ok(json!({"revision":revision}))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
