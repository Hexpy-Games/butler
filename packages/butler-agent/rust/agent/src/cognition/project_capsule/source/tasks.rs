use std::{fs, path::Path};

use tokio_util::sync::CancellationToken;

use crate::{cognition::CognitionResult, public_text::trim_js_whitespace};

use super::super::{check_active, error, types::TaskSummary};
use super::read_text;

struct Candidate {
    id: String,
    project: String,
    path: std::path::PathBuf,
}

pub(super) fn recent(
    data_root: &Path,
    project_id: &str,
    workspace_path: Option<&str>,
    limit: usize,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<Vec<TaskSummary>> {
    let tasks_root = data_root.join("tasks");
    let rows = match fs::read_dir(&tasks_root) {
        Ok(rows) => rows,
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error("project_capsule_source_read_failed")),
    };
    let mut candidates = Vec::new();
    for row in rows {
        check_active(cancellation, deadline)?;
        let row = row.map_err(|_| error("project_capsule_source_read_failed"))?;
        if !row
            .file_type()
            .map_err(|_| error("project_capsule_source_read_failed"))?
            .is_dir()
        {
            continue;
        }
        let path = row.path();
        let project = read_text(data_root, &path.join("project"))?;
        if project == project_id || workspace_path.is_some_and(|workspace| project == workspace) {
            candidates.push(Candidate {
                id: row.file_name().to_string_lossy().into_owned(),
                project,
                path,
            });
        }
    }
    candidates.sort_by(|left, right| right.id.cmp(&left.id));
    candidates.truncate(limit);
    let mut tasks = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        check_active(cancellation, deadline)?;
        let status = read_text(data_root, &candidate.path.join("status"))?;
        let result = nonempty_or(
            read_text(data_root, &candidate.path.join("result.md"))?,
            read_text(data_root, &candidate.path.join("observed_result.md"))?,
        );
        tasks.push(TaskSummary {
            id: candidate.id,
            project: candidate.project,
            status: if status.is_empty() {
                "UNKNOWN".to_owned()
            } else {
                status
            },
            request: read_text(data_root, &candidate.path.join("request.md"))?,
            result,
            source_path: candidate.path.to_string_lossy().into_owned(),
        });
    }
    Ok(tasks)
}

pub(super) fn are_current(
    data_root: &Path,
    expected: &[TaskSummary],
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<bool> {
    for task in expected {
        check_active(cancellation, deadline)?;
        let path = Path::new(&task.source_path);
        let status = read_text(data_root, &path.join("status"))?;
        let current = TaskSummary {
            id: task.id.clone(),
            project: read_text(data_root, &path.join("project"))?,
            status: if status.is_empty() {
                "UNKNOWN".to_owned()
            } else {
                status
            },
            request: read_text(data_root, &path.join("request.md"))?,
            result: nonempty_or(
                read_text(data_root, &path.join("result.md"))?,
                read_text(data_root, &path.join("observed_result.md"))?,
            ),
            source_path: data_root
                .join("tasks")
                .join(&task.id)
                .to_string_lossy()
                .into_owned(),
        };
        if &current != task {
            return Ok(false);
        }
    }
    Ok(true)
}

fn nonempty_or(primary: String, fallback: String) -> String {
    if trim_js_whitespace(&primary).is_empty() {
        fallback
    } else {
        primary
    }
}
