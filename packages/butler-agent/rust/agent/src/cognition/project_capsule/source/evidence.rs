use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use regex::RegexBuilder;
use tokio_util::sync::CancellationToken;

use crate::cognition::{CognitionResult, mutable_paths::ensure_data_authority};

use super::super::{check_active, error, types::ProjectTextEvidence};
use super::{read_text, sanitize_project_memory_id};

pub(super) fn memory_evidence(
    data_root: &Path,
    memory_root: &Path,
    project_id: &str,
    limit: usize,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<Vec<ProjectTextEvidence>> {
    let directory = memory_root.join("tasks");
    if limit == 0 {
        return Ok(Vec::new());
    }
    ensure_data_authority(data_root, &[&directory])?;
    let rows = match fs::read_dir(&directory) {
        Ok(rows) => rows,
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(error("project_capsule_source_read_failed")),
    };
    let mut files: Vec<(PathBuf, f64)> = Vec::new();
    for row in rows {
        check_active(cancellation, deadline)?;
        let row = row.map_err(|_| error("project_capsule_source_read_failed"))?;
        if !row
            .file_type()
            .map_err(|_| error("project_capsule_source_read_failed"))?
            .is_file()
            || !row.file_name().to_string_lossy().ends_with(".md")
        {
            continue;
        }
        let metadata = row
            .metadata()
            .map_err(|_| error("project_capsule_source_read_failed"))?;
        let mtime = metadata
            .modified()
            .map(system_time_millis)
            .unwrap_or_else(|_| system_time_millis(SystemTime::UNIX_EPOCH));
        files.push((row.path(), mtime));
    }
    files.sort_by(|left, right| right.1.total_cmp(&left.1));
    let matcher = project_matcher(project_id)?;
    let mut evidence = Vec::with_capacity(limit);
    for (path, _) in files {
        check_active(cancellation, deadline)?;
        let text = read_text(data_root, &path)?;
        if matcher.is_match(&text) {
            evidence.push(ProjectTextEvidence {
                path: path.to_string_lossy().into_owned(),
                text,
            });
            if evidence.len() >= limit {
                break;
            }
        }
    }
    Ok(evidence)
}

pub(super) fn explicit_feedback(
    data_root: &Path,
    memory_root: &Path,
    project_id: &str,
    limit: usize,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<Vec<ProjectTextEvidence>> {
    let project = sanitize_project_memory_id(project_id);
    let project_root = memory_root.join("rules/projects");
    let main = project_root.join(format!("{project}.md"));
    let mut feedback = Vec::with_capacity(limit);
    if main.exists() {
        let text = read_text(data_root, &main)?;
        if !text.is_empty() {
            feedback.push(ProjectTextEvidence {
                path: main.to_string_lossy().into_owned(),
                text,
            });
        }
    }
    if feedback.len() >= limit {
        feedback.truncate(limit);
        return Ok(feedback);
    }
    let directory = project_root.join(&project);
    if !directory.exists() {
        return Ok(feedback);
    }
    ensure_data_authority(data_root, &[&directory])?;
    let rows = fs::read_dir(&directory).map_err(|_| error("project_capsule_source_read_failed"))?;
    for row in rows {
        check_active(cancellation, deadline)?;
        let row = row.map_err(|_| error("project_capsule_source_read_failed"))?;
        if !row
            .file_type()
            .map_err(|_| error("project_capsule_source_read_failed"))?
            .is_file()
            || !row.file_name().to_string_lossy().ends_with(".md")
        {
            continue;
        }
        let path = row.path();
        let text = read_text(data_root, &path)?;
        if text.is_empty() {
            continue;
        }
        feedback.push(ProjectTextEvidence {
            path: path.to_string_lossy().into_owned(),
            text,
        });
        if feedback.len() >= limit {
            break;
        }
    }
    Ok(feedback)
}

pub(super) fn are_current(
    data_root: &Path,
    evidence: &[ProjectTextEvidence],
    feedback: &[ProjectTextEvidence],
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<bool> {
    for item in evidence.iter().chain(feedback) {
        check_active(cancellation, deadline)?;
        if read_text(data_root, Path::new(&item.path))? != item.text {
            return Ok(false);
        }
    }
    Ok(true)
}

fn project_matcher(project_id: &str) -> CognitionResult<regex::Regex> {
    let pattern = format!(
        "(^|[^a-z0-9가-힣._-]){}([^a-z0-9가-힣._-]|$)",
        regex::escape(project_id)
    );
    RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .map_err(|_| error("project_capsule_project_id_invalid"))
}

fn system_time_millis(time: SystemTime) -> f64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs_f64() * 1_000.0,
        Err(error) => -(error.duration().as_secs_f64() * 1_000.0),
    }
}
