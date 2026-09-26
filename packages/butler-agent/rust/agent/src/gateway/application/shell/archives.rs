use serde_json::{Value, json};

use crate::gateway::GatewayApplicationError;

use super::super::AppApplication;

pub(super) async fn read(
    application: &AppApplication,
    requested_limit: Option<usize>,
    requested_offset: Option<usize>,
) -> Result<Value, GatewayApplicationError> {
    let limit = requested_limit.unwrap_or(20).clamp(1, 100);
    let offset = requested_offset.unwrap_or(0);
    let projects = application.archived_projects_owned().await?;
    let sessions = application.archive_sessions_owned().await?;
    let total = projects.len() + sessions.len();
    let mut items = projects
        .into_iter()
        .map(|(order, item)| (order, true, serde_json::to_value(item)))
        .chain(
            sessions
                .into_iter()
                .map(|(order, item)| (order, false, serde_json::to_value(item))),
        )
        .map(|(order, project, item)| {
            item.map(|item| (order, project, item))
                .map_err(|_| GatewayApplicationError::Internal)
        })
        .collect::<Result<Vec<_>, _>>()?;
    items.sort_by(|left, right| right.0.cmp(&left.0));
    let selected = items.into_iter().skip(offset).take(limit);
    let mut archived_projects = Vec::new();
    let mut archived_sessions = Vec::new();
    for (_, is_project, value) in selected {
        if is_project {
            archived_projects.push(value);
        } else {
            archived_sessions.push(value);
        }
    }
    Ok(json!({
        "projects": archived_projects,
        "sessions": archived_sessions,
        "pagination": {
            "limit": limit,
            "offset": offset,
            "total": total,
            "has_more": offset.saturating_add(limit) < total,
        }
    }))
}
