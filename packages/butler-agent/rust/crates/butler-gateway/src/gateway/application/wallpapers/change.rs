//! `wallpaper.changed`: one event per change of an effective wallpaper,
//! appended with the write's `settings.updated` / `project.updated`, so the
//! UI can show what changed and offer to undo it.

use serde_json::{Map, Value, json};

use crate::gateway::AppWallpaperScope;

pub(in crate::gateway::application) const EVENT: &str = "wallpaper.changed";

/// Who wrote a wallpaper.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::gateway::application) enum WallpaperOrigin {
    /// The agent route.
    Agent,
    /// The settings screen or the project dashboard.
    User,
}

/// `{scope, projectId?, previous, next, origin}`, or `None` when the
/// effective wallpaper did not change.
pub(in crate::gateway::application) fn payload(
    scope: AppWallpaperScope,
    project_id: Option<&str>,
    previous: &Value,
    next: &Value,
    origin: WallpaperOrigin,
) -> Option<Map<String, Value>> {
    if previous == next {
        return None;
    }
    let mut payload = Map::new();
    payload.insert("scope".into(), json!(scope));
    if let Some(project_id) = project_id {
        payload.insert("projectId".into(), json!(project_id));
    }
    payload.insert("previous".into(), previous.clone());
    payload.insert("next".into(), next.clone());
    let origin = match origin {
        WallpaperOrigin::Agent => "agent",
        WallpaperOrigin::User => "user",
    };
    payload.insert("origin".into(), json!(origin));
    Some(payload)
}
