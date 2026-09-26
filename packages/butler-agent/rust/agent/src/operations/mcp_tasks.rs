//! Read-only projections and cleanup planning for the retained MCP task tools.

use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskInfo {
    pub(crate) task_id: String,
    pub(crate) status: String,
    pub(crate) project: String,
    pub(crate) request: String,
    pub(crate) result: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct McpTaskCounts {
    pub(crate) total: usize,
    pub(crate) running: usize,
    pub(crate) done: usize,
    pub(crate) failed: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct McpTaskProject {
    pub(crate) project: String,
    pub(crate) total: usize,
    pub(crate) done: usize,
    pub(crate) failed: usize,
    pub(crate) running: usize,
    pub(crate) recent: Vec<McpTaskInfo>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct McpTaskCleanupPlan {
    pub(crate) directories: Vec<PathBuf>,
    pub(crate) deleted_count: usize,
}

pub(crate) fn read_mcp_task(data_root: &Path, task_id: &str) -> McpTaskInfo {
    let task_dir = task_directory(data_root, task_id);
    if !safe_task_id(task_id) || !task_dir.exists() {
        return unknown(task_id);
    }
    let status = read_trimmed(&task_dir.join("status"));
    McpTaskInfo {
        task_id: task_id.to_owned(),
        result: matches!(status.as_str(), "DONE" | "FAILED")
            .then(|| read_trimmed(&task_dir.join("result.md"))),
        project: read_trimmed(&task_dir.join("project")),
        request: read_trimmed(&task_dir.join("request.md")),
        status,
    }
}

pub(crate) fn read_mcp_task_list(data_root: &Path, filter: Option<&str>) -> Vec<McpTaskInfo> {
    let Ok(entries) = std::fs::read_dir(data_root.join("tasks")) else {
        return Vec::new();
    };
    let mut tasks = entries
        .filter_map(Result::ok)
        .map(|entry| read_mcp_task(data_root, &entry.file_name().to_string_lossy()))
        .filter(|task| filter.is_none_or(|status| task.status == status.to_ascii_uppercase()))
        .collect::<Vec<_>>();
    if filter.is_none() {
        tasks.sort_by(|left, right| right.task_id.cmp(&left.task_id));
    }
    tasks
}

pub(crate) fn read_mcp_task_counts(data_root: &Path) -> McpTaskCounts {
    let tasks_root = data_root.join("tasks");
    let Ok(entries) = std::fs::read_dir(&tasks_root) else {
        return McpTaskCounts::default();
    };
    let mut counts = McpTaskCounts::default();
    for entry in entries.filter_map(Result::ok) {
        counts.total += 1;
        match read_trimmed(&tasks_root.join(entry.file_name()).join("status")).as_str() {
            "RUNNING" => counts.running += 1,
            "DONE" => counts.done += 1,
            "FAILED" => counts.failed += 1,
            _ => {}
        }
    }
    counts
}

pub(crate) fn read_mcp_task_projects(
    data_root: &Path,
    home: &Path,
) -> Result<Vec<McpTaskProject>, String> {
    let tasks_root = data_root.join("tasks");
    let entries = match std::fs::read_dir(&tasks_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let excluded = [
        String::new(),
        "dev".into(),
        home.join("dev").to_string_lossy().into_owned(),
    ];
    let mut groups = indexmap::IndexMap::<String, Vec<McpTaskInfo>>::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let task = read_mcp_task(data_root, &entry.file_name().to_string_lossy());
        if excluded.contains(&task.project) {
            continue;
        }
        groups.entry(task.project.clone()).or_default().push(task);
    }

    let mut projects = groups
        .into_iter()
        .map(|(project, mut tasks)| {
            tasks.sort_by(|left, right| right.task_id.cmp(&left.task_id));
            let total = tasks.len();
            let done = tasks.iter().filter(|task| task.status == "DONE").count();
            let failed = tasks.iter().filter(|task| task.status == "FAILED").count();
            let running = tasks.iter().filter(|task| task.status == "RUNNING").count();
            let recent = tasks.into_iter().take(3).collect();
            McpTaskProject {
                project,
                total,
                done,
                failed,
                running,
                recent,
            }
        })
        .collect::<Vec<_>>();
    projects.sort_by(|left, right| {
        right
            .recent
            .first()
            .map(|task| &task.task_id)
            .cmp(&left.recent.first().map(|task| &task.task_id))
    });
    Ok(projects)
}

pub(crate) fn cleanup_plan(data_root: &Path, now_ms: f64) -> Result<McpTaskCleanupPlan, String> {
    let tasks_root = data_root.join("tasks");
    let entries = match std::fs::read_dir(&tasks_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(McpTaskCleanupPlan {
                directories: Vec::new(),
                deleted_count: 0,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut tasks = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let epoch_ms = numeric_task_id(&name);
        let Some(epoch_ms) = epoch_ms else { continue };
        tasks.push((
            name,
            epoch_ms,
            read_trimmed(&entry.path().join("status")),
            entry.path(),
        ));
    }

    let cutoff = now_ms - 30.0 * 24.0 * 60.0 * 60.0 * 1_000.0;
    let mut selected = Vec::new();
    let mut remaining = Vec::new();
    for task in tasks {
        if matches!(task.2.as_str(), "DONE" | "FAILED") && task.1 < cutoff {
            selected.push((task.0, task.1, task.3));
        } else {
            remaining.push(task);
        }
    }
    if remaining.len() > 100 {
        let mut deletable = remaining
            .iter()
            .filter(|task| matches!(task.2.as_str(), "DONE" | "FAILED"))
            .map(|task| (task.0.clone(), task.1, task.3.clone()))
            .collect::<Vec<_>>();
        deletable.sort_by(|left, right| left.1.total_cmp(&right.1));
        let count = (remaining.len() - 100).min(deletable.len());
        selected.extend(deletable.into_iter().take(count));
    }
    selected.sort_by(|left, right| left.1.total_cmp(&right.1).then(left.0.cmp(&right.0)));
    let directories = selected.into_iter().map(|task| task.2).collect::<Vec<_>>();
    Ok(McpTaskCleanupPlan {
        deleted_count: directories.len(),
        directories,
    })
}

fn safe_task_id(task_id: &str) -> bool {
    let mut components = Path::new(task_id).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn task_directory(data_root: &Path, task_id: &str) -> PathBuf {
    data_root.join("tasks").join(task_id)
}

fn numeric_task_id(task_id: &str) -> Option<f64> {
    let value = task_id.trim();
    let number = value.parse::<f64>().ok()?;
    (!number.is_nan()).then_some(number)
}

fn read_trimmed(path: &Path) -> String {
    std::fs::read_to_string(path)
        .map(|content| content.trim().to_owned())
        .unwrap_or_default()
}

fn unknown(task_id: &str) -> McpTaskInfo {
    McpTaskInfo {
        task_id: task_id.to_owned(),
        status: "UNKNOWN".into(),
        project: String::new(),
        request: String::new(),
        result: None,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    use super::{cleanup_plan, read_mcp_task, read_mcp_task_counts, read_mcp_task_list};

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "butler-mcp-tasks-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn task(root: &Path, id: &str, status: &str) {
        let path = root.join("tasks").join(id);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("status"), status).unwrap();
        fs::write(path.join("project"), "sample").unwrap();
        fs::write(path.join("request.md"), "request").unwrap();
        if matches!(status, "DONE" | "FAILED") {
            fs::write(path.join("result.md"), "result").unwrap();
        }
    }

    #[test]
    fn task_read_list_counts_and_project_facts_match_source_contract() {
        let root = fixture();
        task(&root, "100", "DONE");
        task(&root, "200", "RUNNING");
        assert_eq!(read_mcp_task(&root, "missing").status, "UNKNOWN");
        assert_eq!(
            read_mcp_task(&root, "100").result.as_deref(),
            Some("result")
        );
        assert_eq!(read_mcp_task_counts(&root).total, 2);
        assert_eq!(read_mcp_task_counts(&root).running, 1);
        assert_eq!(read_mcp_task_list(&root, Some("done")).len(), 1);
        assert_eq!(read_mcp_task_list(&root, None)[0].task_id, "200");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_plan_only_selects_numeric_terminal_directories() {
        let root = fixture();
        task(&root, "100", "DONE");
        task(&root, "200", "RUNNING");
        task(&root, "not-numeric", "DONE");
        let plan = cleanup_plan(&root, 31.0 * 24.0 * 60.0 * 60.0 * 1_000.0).unwrap();
        assert_eq!(plan.deleted_count, 1);
        assert!(plan.directories[0].ends_with("100"));
        fs::remove_dir_all(root).unwrap();
    }
}
