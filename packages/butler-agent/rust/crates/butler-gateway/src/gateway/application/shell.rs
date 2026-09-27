//! Native projections used by the App shell's one-shot reads.

mod archives;

use serde_json::{Value, json};
use unicode_normalization::UnicodeNormalization;

use super::{AppApplication, AppSessionSummary, GatewayApplicationError};

impl AppApplication {
    pub(super) async fn app_info(&self) -> Result<Value, GatewayApplicationError> {
        let version = self.dependencies.runtime_info.app_version()?;
        let settings = self.worker_profile_settings().await?;
        Ok(json!({
            "name": "Butler",
            "version": version,
            "repository_url": "https://github.com/Hexpy-Games/butler",
            "protocol_version": crate::gateway::protocol::APP_PROTOCOL_VERSION,
            "developer_mode_available": true,
            "developer_mode_enabled": settings.get("diagnostics_enabled").and_then(Value::as_bool) == Some(true),
        }))
    }

    pub(crate) async fn read_navigation(&self) -> Result<Value, GatewayApplicationError> {
        let chats = self.list_sessions(Some("chat".into()), None).await?;
        let projects = self.list_projects(true).await?;
        let automations = self.list_automations_owned(None).await?;
        let space = self.read_space().await?;
        let generated_at = self.dependencies.identity_clock.now_iso();
        Ok(json!({
            "space": space,
            "chats": chats,
            "projects": projects.projects,
            "automations_summary": {
                "total_count": automations.automations.len(),
                "enabled_count": automations.automations.iter().filter(|item| item.state == "enabled").count(),
            },
            "settings_summary": {"profile_label": "Local Butler"},
            "generated_at": generated_at,
        }))
    }

    pub(crate) async fn read_space(&self) -> Result<Value, GatewayApplicationError> {
        self.read_space_owned().await
    }

    pub(crate) async fn list_archives_owned(
        &self,
        limit: Option<usize>,
        offset: Option<usize>,
    ) -> Result<Value, GatewayApplicationError> {
        let page = archives::read(self, limit, offset).await?;
        Ok(page)
    }

    pub(crate) async fn search_command_palette(
        &self,
        query: String,
    ) -> Result<Value, GatewayApplicationError> {
        let space = self.read_space().await?;
        let projects = self.list_projects(false).await?.projects;
        let sessions = self.list_sessions(None, None).await?;
        let automations = self.list_automations_owned(None).await?.automations;
        Ok(command_palette(
            &query,
            &space,
            &projects,
            &sessions,
            &automations,
        ))
    }
}

fn command_palette(
    query: &str,
    space: &Value,
    projects: &[super::AppProjectSummary],
    sessions: &[AppSessionSummary],
    automations: &[super::AutomationSummary],
) -> Value {
    use std::collections::{HashMap, HashSet};

    let normalize = |value: &str| value.nfkc().collect::<String>().to_lowercase();
    let needle = normalize(query.trim());
    let terms = needle.split_whitespace().collect::<Vec<_>>();
    let matches = |value: &str| {
        let candidate = normalize(value);
        terms.iter().all(|term| candidate.contains(term))
    };
    let project_ids = projects
        .iter()
        .filter(|project| !project.archived)
        .map(|project| project.id.as_str())
        .collect::<HashSet<_>>();
    let nodes = space
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let groups = space
        .get("groups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let node_by_key = nodes
        .iter()
        .filter_map(|node| Some((node.get("key")?.as_str()?.to_owned(), node)))
        .collect::<HashMap<_, _>>();
    let project_names = projects
        .iter()
        .map(|project| (project.id.as_str(), project.display_name.as_str()))
        .collect::<HashMap<_, _>>();
    let group_names = groups
        .iter()
        .filter_map(|group| Some((group.get("id")?.as_str()?, group.get("title")?.as_str()?)))
        .collect::<HashMap<_, _>>();
    let location = |key: &str| {
        let mut names = Vec::new();
        let mut parent = node_by_key
            .get(key)
            .and_then(|node| node.get("parentKey"))
            .and_then(Value::as_str);
        while let Some(parent_key) = parent {
            let Some(node) = node_by_key.get(parent_key) else {
                break;
            };
            let entity_id = node.get("entityId").and_then(Value::as_str).unwrap_or("");
            let title = match node.get("kind").and_then(Value::as_str) {
                Some("project") => project_names.get(entity_id).copied(),
                Some("group") => group_names.get(entity_id).copied(),
                _ => None,
            };
            if let Some(title) = title {
                names.push(title);
            }
            parent = node.get("parentKey").and_then(Value::as_str);
        }
        names.reverse();
        names.join(" › ")
    };
    let mut results = Vec::new();
    let mut recency = HashMap::new();
    for session in sessions.iter().filter(|session| {
        !session.archived
            && session
                .project_id
                .as_deref()
                .is_none_or(|project| project_ids.contains(project))
    }) {
        let place = location(&format!("s:{}", session.id));
        if matches(&format!("{} {place}", session.title)) {
            results.push(json!({"id":session.id,"kind":if session.kind == super::AppChatKind::Project {"project_session"} else {"chat"},
                "title":session.title,"subtitle":if place.is_empty() {if session.kind == super::AppChatKind::Project {"Project chat"} else {"Chat"}} else {&place},
                "route":format!("session:{}",session.id)}));
        }
        recency.insert(session.id.as_str(), session.last_activity_at.as_str());
    }
    for project in projects.iter().filter(|project| !project.archived) {
        let place = location(&format!("p:{}", project.id));
        if matches(&format!("{} {place}", project.display_name)) {
            results.push(json!({"id":project.id,"kind":"project","title":project.display_name,
                "subtitle":if place.is_empty() {"Project"} else {&place},"route":format!("project:{}",project.id)}));
        }
        recency.insert(project.id.as_str(), project.last_activity_at.as_str());
    }
    for group in &groups {
        let id = group.get("id").and_then(Value::as_str).unwrap_or("");
        let title = group.get("title").and_then(Value::as_str).unwrap_or("");
        let visible = group
            .get("scopeProjectId")
            .and_then(Value::as_str)
            .is_none_or(|project| project_ids.contains(project));
        let place = location(&format!("g:{id}"));
        if visible && matches(&format!("{title} {place}")) {
            results.push(json!({"id":id,"kind":"group","title":title,
                "subtitle":if place.is_empty() {"스페이스"} else {&place},"route":format!("group:{id}")}));
        }
    }
    for automation in automations {
        if matches(&automation.title) {
            results.push(json!({"id":automation.id,"kind":"automation","title":automation.title,
                "subtitle":automation.interval_label,"route":format!("automation:{}",automation.id)}));
        }
    }
    for section in [
        "General",
        "Appearance",
        "Server/Bridge",
        "Models/Access",
        "Privacy/Data",
        "Diagnostics",
        "System events",
        "Archived",
    ] {
        if matches(section) {
            let slug = section
                .to_lowercase()
                .replace(|character: char| !character.is_ascii_alphanumeric(), "-");
            let slug = slug.trim_matches('-');
            results.push(
                json!({"id":format!("settings:{slug}"),"kind":"settings","title":section,
                "subtitle":"Settings","route":format!("settings:{section}")}),
            );
        }
    }
    let rank = |title: &str| {
        let title = normalize(title);
        if title == needle {
            0
        } else if title.starts_with(&needle) {
            1
        } else {
            2
        }
    };
    results.sort_by(|left, right| {
        let left_title = left["title"].as_str().unwrap_or("");
        let right_title = right["title"].as_str().unwrap_or("");
        rank(left_title)
            .cmp(&rank(right_title))
            .then_with(|| {
                let left_time = left["id"]
                    .as_str()
                    .and_then(|id| recency.get(id))
                    .copied()
                    .unwrap_or("");
                let right_time = right["id"]
                    .as_str()
                    .and_then(|id| recency.get(id))
                    .copied()
                    .unwrap_or("");
                right_time.cmp(left_time)
            })
            .then_with(|| {
                left["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(right["id"].as_str().unwrap_or(""))
            })
    });
    json!({"results":results.into_iter().take(30).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests;
