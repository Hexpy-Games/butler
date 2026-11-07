//! liveNavigationProjection / Reconciliation / SessionPolicy.
use super::NavigationModel;
use crate::ui::source::wire::{AppEventEnvelope, ChatKind, SessionSummary, TimelineEventPayload};

impl NavigationModel {
    pub(crate) fn apply_live_event(&mut self, event: &AppEventEnvelope) -> bool {
        let navigation_event = matches!(
            event.r#type.as_str(),
            "session.created" | "session.updated" | "session.permanently_deleted"
        );
        let invalidate = navigation_event
            || event.r#type.starts_with("space.")
            || event.r#type.starts_with("project.");
        if invalidate {
            self.generation += 1;
        }
        if !navigation_event {
            return invalidate;
        }
        let Some(view) = &mut self.view else {
            return navigation_event;
        };
        let Ok(payload) = serde_json::from_value::<TimelineEventPayload>(event.payload.clone())
        else {
            return navigation_event;
        };
        if event.r#type == "session.permanently_deleted" {
            let id = payload
                .session
                .as_ref()
                .and_then(|v| v.get("id"))
                .and_then(|v| v.as_str())
                .or(payload.session_id.as_deref());
            if let Some(id) = id {
                remove_session(view, id);
                self.project_space();
            }
        } else if navigation_event
            && let Some(incoming) = payload.session.as_ref().and_then(safe_session_summary)
        {
            let existing_location = view.chats.iter().any(|s| s.id == incoming.id)
                || view
                    .projects
                    .iter()
                    .filter(|p| Some(&p.id) != incoming.project_id.as_ref())
                    .any(|p| p.sessions.iter().flatten().any(|s| s.id == incoming.id));
            if incoming.kind != ChatKind::Project || existing_location {
                return true;
            }
            let Some(project) = view
                .projects
                .iter_mut()
                .find(|p| Some(&p.id) == incoming.project_id.as_ref())
            else {
                return true;
            };
            let sessions = project.sessions.get_or_insert_default();
            let current = sessions.iter().position(|s| s.id == incoming.id);
            if let Some(index) = current {
                if sessions[index].kind != incoming.kind
                    || timestamp(&incoming.updated_at) <= timestamp(&sessions[index].updated_at)
                {
                    return true;
                }
                if incoming.archived {
                    sessions.remove(index);
                } else {
                    sessions[index] =
                        merge_session_summary(&sessions[index], incoming, payload.session.as_ref());
                }
            } else if event.r#type == "session.created" && !incoming.archived {
                sessions.push(incoming);
            }
            sessions.sort_by(|a, b| {
                b.pinned
                    .cmp(&a.pinned)
                    .then(timestamp(&b.updated_at).cmp(&timestamp(&a.updated_at)))
                    .then(timestamp(&b.created_at).cmp(&timestamp(&a.created_at)))
            });
            self.project_space();
        }
        navigation_event
            || event.r#type.starts_with("space.")
            || event.r#type.starts_with("project.")
    }
}

fn timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.timestamp_millis())
}

fn safe_session_summary(value: &serde_json::Value) -> Option<SessionSummary> {
    let mut value = value.as_object()?.clone();
    let keys = [
        "id",
        "kind",
        "title",
        "project_id",
        "project",
        "session_hint",
        "created_at",
        "updated_at",
        "last_activity_at",
        "last_message_preview",
        "active_turn_state",
        "running_delegated_work",
        "safe_status_label",
        "unread",
        "pinned",
        "archived",
        "automation_target_count",
    ];
    value.retain(|key, _| keys.contains(&key.as_str()));
    for key in ["created_at", "updated_at", "last_activity_at"] {
        timestamp(value.get(key)?.as_str()?)?;
    }
    if value.get("id")?.as_str()?.trim().is_empty() {
        return None;
    }
    for key in ["pinned", "archived"] {
        value.get(key)?.as_bool()?;
    }
    for key in [
        "project_id",
        "session_hint",
        "last_message_preview",
        "active_turn_state",
        "safe_status_label",
    ] {
        if value.get(key).is_some_and(|v| !v.is_string()) {
            return None;
        }
    }
    for key in ["unread", "running_delegated_work"] {
        if value.get(key).is_some_and(|v| !v.is_boolean()) {
            return None;
        }
    }
    if value.get("project").is_some_and(|v| !v.is_object())
        || value
            .get("automation_target_count")
            .is_some_and(|v| v.as_i64().is_none_or(|n| n < 0))
    {
        return None;
    }
    let result: SessionSummary = serde_json::from_value(value.into()).ok()?;
    if result.kind == ChatKind::Unknown
        || (result.kind == ChatKind::Project
            && result
                .project_id
                .as_ref()
                .is_none_or(|id| id.trim().is_empty()))
    {
        return None;
    }
    if result
        .project
        .as_ref()
        .is_some_and(|p| Some(&p.id) != result.project_id.as_ref())
    {
        return None;
    }
    Some(result)
}

fn merge_session_summary(
    current: &SessionSummary,
    mut incoming: SessionSummary,
    raw: Option<&serde_json::Value>,
) -> SessionSummary {
    if raw.and_then(|v| v.get("session_hint")).is_none() {
        incoming.session_hint.clone_from(&current.session_hint);
    }
    if raw.and_then(|v| v.get("last_message_preview")).is_none() {
        incoming
            .last_message_preview
            .clone_from(&current.last_message_preview);
    }
    if raw.and_then(|v| v.get("active_turn_state")).is_none() {
        incoming
            .active_turn_state
            .clone_from(&current.active_turn_state);
    }
    if raw.and_then(|v| v.get("safe_status_label")).is_none() {
        incoming
            .safe_status_label
            .clone_from(&current.safe_status_label);
    }
    if raw.and_then(|v| v.get("unread")).is_none() {
        incoming.unread = current.unread;
    }
    if raw.and_then(|v| v.get("running_delegated_work")).is_none() {
        incoming.running_delegated_work = current.running_delegated_work;
    }
    if raw.and_then(|v| v.get("automation_target_count")).is_none() {
        incoming.automation_target_count = current.automation_target_count;
    }
    incoming.project = incoming.project.or_else(|| current.project.clone());
    incoming.epic_ids.clone_from(&current.epic_ids);
    incoming.subtasks.clone_from(&current.subtasks);
    incoming.branch_seed.clone_from(&current.branch_seed);
    incoming.work_progress.clone_from(&current.work_progress);
    incoming
        .safe_status_label_key
        .clone_from(&current.safe_status_label_key);
    incoming
        .safe_status_label_parameters
        .clone_from(&current.safe_status_label_parameters);
    incoming
        .safe_status_content
        .clone_from(&current.safe_status_content);
    incoming.attention_required = current.attention_required;
    incoming
        .attention_source
        .clone_from(&current.attention_source);
    incoming
}

fn remove_session(view: &mut crate::ui::source::wire::NavigationView, id: &str) {
    view.chats.retain(|s| s.id != id);
    for project in &mut view.projects {
        if let Some(sessions) = &mut project.sessions {
            sessions.retain(|s| s.id != id);
        }
    }
}
