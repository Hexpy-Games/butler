//! Revision-checked project dashboard description, source pins and wallpaper.

use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use super::contracts::{
    AppProjectDashboardPinRef, AppProjectDashboardPreferencesUpdate,
    AppProjectDashboardSourceQuery, invalid_request, preferences_changed,
};
use super::project::{DashboardProject, pins, read_project};
use crate::gateway::AppWallpaperScope;
use crate::gateway::application::storage::AppStorageCode;
use crate::gateway::application::wallpapers::{self, WallpaperOrigin};
use crate::gateway::application::{events, settings};

const PIN_KINDS: &[&str] = &["work", "task", "plan", "spec", "report", "artifact"];
/// Revision races one wallpaper write retries; each round, one writer wins.
const WALLPAPER_ATTEMPTS: usize = 5;

/// Sets a project's wallpaper (`"inherit"` or a checked source) at whatever
/// revision is current, re-reading after a concurrent write wins the revision
/// check. Returns the previous wallpaper; an unchanged one is not rewritten.
pub(super) async fn set_wallpaper(
    application: &AppApplication,
    project_id: &str,
    wallpaper: &Value,
    origin: WallpaperOrigin,
) -> Result<Value, GatewayApplicationError> {
    for _ in 0..WALLPAPER_ATTEMPTS {
        let project = read_project(application, project_id).await?;
        let preferences = super::project::preferences(&project).map_err(app_error)?;
        let previous = settings::project_wallpaper_view(preferences.get("wallpaper"));
        if &previous == wallpaper {
            return Ok(previous);
        }
        let write = AppProjectDashboardPreferencesUpdate {
            expected_revision: project.preferences_revision,
            description: None,
            pinned_source_refs: None,
            wallpaper: Some(wallpaper.clone()),
        };
        match update(application, project_id, write, origin).await {
            Err(GatewayApplicationError::Public { code, .. }) if code == "preferences_changed" => {}
            result => return result.map(|_| previous),
        }
    }
    Err(preferences_changed())
}

pub(super) async fn update(
    application: &AppApplication,
    project_id: &str,
    update: AppProjectDashboardPreferencesUpdate,
    origin: WallpaperOrigin,
) -> Result<Value, GatewayApplicationError> {
    if update.expected_revision > i64::MAX as u64
        || (update.description.is_none()
            && update.pinned_source_refs.is_none()
            && update.wallpaper.is_none())
        || update
            .description
            .as_ref()
            .is_some_and(|value| value.encode_utf16().count() > 2_000)
    {
        return Err(invalid_request());
    }
    if let Some(wallpaper) = update.wallpaper.as_ref() {
        settings::check_project_wallpaper(wallpaper)?;
    }
    let project = read_project(application, project_id).await?;
    if project.preferences_revision != update.expected_revision {
        return Err(preferences_changed());
    }
    let current_pins = pins(&project).map_err(app_error)?;
    let resolved = match update.pinned_source_refs.as_deref() {
        Some(requested) => {
            Some(resolve_pins(application, &project, &current_pins, requested).await?)
        }
        None => None,
    };
    let mut preferences = super::project::preferences(&project).map_err(app_error)?;
    if let Some(pins) = resolved {
        preferences["pinnedSourceRefs"] = Value::Array(pins);
    }
    let asset = update
        .wallpaper
        .as_ref()
        .and_then(settings::source_image_asset)
        .map(str::to_owned);
    let wallpaper_event = update.wallpaper.as_ref().and_then(|next| {
        let previous = settings::project_wallpaper_view(preferences.get("wallpaper"));
        let project = Some(project.id.as_str());
        wallpapers::change_payload(AppWallpaperScope::Project, project, &previous, next, origin)
    });
    if let Some(wallpaper) = update.wallpaper {
        preferences["wallpaper"] = wallpaper;
    }
    let preferences_json = serde_json::to_string(&preferences).map_err(|error| {
        GatewayApplicationError::Public {
            status: 500,
            code: "app_project_preferences_invalid".into(),
            message: error.to_string(),
            source: None,
        }
        .with_source(error)
    })?;
    let revision = commit(
        application,
        PreferencesWrite {
            project_id: project.id,
            expected: update.expected_revision,
            description: update.description.or(project.description),
            preferences_json,
            asset,
            wallpaper_event,
        },
    )
    .await?;
    Ok(json!({"revision":revision}))
}

/// Validates requested pins, re-reading a pin's source unless it is retained
/// unchanged from the current preferences.
async fn resolve_pins(
    application: &AppApplication,
    project: &DashboardProject,
    current_pins: &[Value],
    requested: &[AppProjectDashboardPinRef],
) -> Result<Vec<Value>, GatewayApplicationError> {
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
    Ok(normalized)
}

struct PreferencesWrite {
    project_id: String,
    expected: u64,
    description: Option<String>,
    preferences_json: String,
    /// The wallpaper image asset the new preferences reference, if any.
    asset: Option<String>,
    /// `wallpaper.changed` when the write changes the wallpaper.
    wallpaper_event: Option<Map<String, Value>>,
}

/// Stores the preferences if the revision still matches and emits
/// `project.updated` (and `wallpaper.changed` when the wallpaper changes).
/// A referenced wallpaper asset must still exist: the check
/// runs in this write transaction on the one App SQLite lane, where wallpaper
/// deletion scans for references and deletes in a single operation, so a
/// deletion cannot slip between the check and the new reference.
async fn commit(
    application: &AppApplication,
    write: PreferencesWrite,
) -> Result<u64, GatewayApplicationError> {
    let clock = application.dependencies.identity_clock.clone();
    let subscribers = application.subscribers.clone();
    let PreferencesWrite {
        project_id: project_key,
        expected,
        description,
        preferences_json,
        asset,
        wallpaper_event,
    } = write;
    application
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
            if current.map(|value| u64::try_from(value.max(0)).unwrap_or_default()) != Some(expected) {
                return Err(AppStorageError::new(
                    AppStorageCode::PreferencesChanged,
                    "Preferences changed. Reload them.",
                ));
            }
            if let Some(asset) = asset.as_deref()
                && !wallpapers::asset_exists(&tx, asset)?
            {
                return Ok(Err(settings::unknown_project_wallpaper()));
            }
            tx.execute(
                "UPDATE projects SET description=?1,dashboard_preferences_json=?2,\
                 dashboard_preferences_revision=?3 WHERE id=?4 AND dashboard_preferences_revision=?5",
                params![description, preferences_json, i64::try_from(expected + 1).unwrap_or(i64::MAX), project_key, i64::try_from(expected).unwrap_or(i64::MAX)],
            )
            .map_err(AppStorageError::sqlite)?;
            let row = super::super::rows::any_by_id(&tx, &project_key)?
                .ok_or_else(|| AppStorageError::new(AppStorageCode::ProjectNotFound, "Project not found."))?;
            let project = super::super::rows::summary(row, None);
            let payload = butler_core::json::json_object!({"project":project});
            let now = clock.now_iso();
            let mut appended =
                vec![events::append_unpublished(&tx, "project.updated", None, payload, &now)?];
            if let Some(payload) = wallpaper_event {
                appended.push(events::append_unpublished(&tx, wallpapers::CHANGED, None, payload, &now)?);
            }
            tx.commit().map_err(AppStorageError::sqlite)?;
            for event in &appended {
                events::publish(&subscribers, event);
            }
            Ok(Ok(expected + 1))
        })
        .await
        .map_err(|error| {
            if error.code() == "preferences_changed" {
                preferences_changed()
            } else {
                app_error(error)
            }
        })?
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
