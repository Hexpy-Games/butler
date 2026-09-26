mod evidence;
mod graph;
mod tasks;

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{CognitionPathEnvironment, CognitionResult, mutable_paths::ensure_data_authority},
    public_text::trim_js_whitespace,
};

use super::{
    check_active, error,
    render::render,
    types::{
        PreparedCapsule, ProjectCapsuleSourceCounts, ProjectCapsuleSourceSnapshot,
        ProjectRegistryEntry,
    },
    write::{failure_log_path, project_lock_path},
};

const TASK_LIMIT: usize = 5;

pub(super) fn prepare(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
    workspace_override: Option<&str>,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<PreparedCapsule> {
    check_active(cancellation, deadline)?;
    let memory_root = paths.memory_root(data_root);
    let target = capsule_path(&memory_root, project_id);
    let project_lock = project_lock_path(data_root, paths, project_id);
    let failure_log = failure_log_path(data_root, paths);
    ensure_data_authority(
        data_root,
        &[&memory_root, &project_lock, &failure_log, &target],
    )?;

    let registry = read_registry_entries(data_root, cancellation, deadline)?
        .into_iter()
        .find(|entry| entry.name == project_id)
        .map(|entry| entry.raw);
    let workspace_path = workspace_override.map(str::to_owned).or_else(|| {
        registry
            .as_ref()
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    });
    let tasks = tasks::recent(
        data_root,
        project_id,
        workspace_path.as_deref(),
        TASK_LIMIT,
        cancellation,
        deadline,
    )?;
    let evidence = evidence::memory_evidence(
        data_root,
        &memory_root,
        project_id,
        TASK_LIMIT,
        cancellation,
        deadline,
    )?;
    let feedback = evidence::explicit_feedback(
        data_root,
        &memory_root,
        project_id,
        TASK_LIMIT,
        cancellation,
        deadline,
    )?;
    let graph = graph::list(data_root, &memory_root, project_id, cancellation, deadline)?;
    let snapshot = ProjectCapsuleSourceSnapshot {
        registry,
        tasks,
        evidence,
        feedback,
        graph,
        workspace_path,
    };
    let source_revision = fingerprint(&snapshot)?;
    let mut counts = ProjectCapsuleSourceCounts {
        registry: usize::from(snapshot.registry.is_some()),
        tasks: snapshot.tasks.len(),
        explicit_feedback: snapshot.feedback.len(),
        project_hot_cache: 0,
        memory_evidence: snapshot.evidence.len(),
        graph_evidence: snapshot.graph.len(),
        promoted: 0,
    };
    let body = render(project_id, &snapshot, &mut counts, super::now_epoch_ms())?;
    Ok(PreparedCapsule {
        project_id: project_id.to_owned(),
        path: target,
        body,
        source_revision,
        snapshot,
    })
}

pub(super) fn read_registry_entries(
    data_root: &Path,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<Vec<ProjectRegistryEntry>> {
    check_active(cancellation, deadline)?;
    let path = data_root.join("butler.config.json");
    ensure_data_authority(data_root, &[&path])?;
    let Ok(raw) = fs::read_to_string(path) else {
        return Ok(Vec::new());
    };
    let Ok(config) = serde_json::from_str::<Value>(&raw) else {
        return Ok(Vec::new());
    };
    let projects = match config.get("projects") {
        Some(Value::Array(projects)) => projects.iter().collect::<Vec<_>>(),
        Some(Value::Object(projects)) => projects.values().collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let mut entries = Vec::new();
    for project in projects {
        check_active(cancellation, deadline)?;
        let Some(name) = project.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = trim_js_whitespace(name);
        if name.is_empty() {
            continue;
        }
        entries.push(ProjectRegistryEntry {
            name: name.to_owned(),
            raw: project.clone(),
        });
    }
    Ok(entries)
}

pub(super) fn read_text(data_root: &Path, path: &Path) -> CognitionResult<String> {
    ensure_data_authority(data_root, &[path])?;
    Ok(fs::read_to_string(path)
        .map(|text| trim_js_whitespace(&text).to_owned())
        .unwrap_or_default())
}

pub(super) fn capsule_path(memory_root: &Path, project_id: &str) -> PathBuf {
    let safe = sanitize_project_memory_id(project_id);
    memory_root.join("projects").join(format!("{safe}.md"))
}

pub(super) fn sanitize_project_memory_id(project_id: &str) -> String {
    project_id
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | '\0') {
                '_'
            } else {
                character
            }
        })
        .collect()
}

pub(super) fn ensure_source_authority(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    target: &Path,
) -> CognitionResult<()> {
    let cognition_root = paths.cognition_root(data_root);
    let memory_root = paths.memory_root(data_root);
    let lock_path = paths.consolidation_lock(data_root);
    let tasks_root = data_root.join("tasks");
    ensure_data_authority(
        data_root,
        &[
            &cognition_root,
            &memory_root,
            &lock_path,
            &tasks_root,
            target,
        ],
    )
}

pub(super) fn sources_are_current(
    data_root: &Path,
    paths: &CognitionPathEnvironment,
    project_id: &str,
    snapshot: &ProjectCapsuleSourceSnapshot,
    cancellation: &CancellationToken,
    deadline: i64,
) -> CognitionResult<bool> {
    check_active(cancellation, deadline)?;
    let current_registry = read_registry_entries(data_root, cancellation, deadline)?
        .into_iter()
        .find(|entry| entry.name == project_id)
        .map(|entry| entry.raw);
    if json_text(current_registry.as_ref())? != json_text(snapshot.registry.as_ref())? {
        return Ok(false);
    }
    if !tasks::are_current(data_root, &snapshot.tasks, cancellation, deadline)?
        || !evidence::are_current(
            data_root,
            &snapshot.evidence,
            &snapshot.feedback,
            cancellation,
            deadline,
        )?
        || !graph::are_current(
            data_root,
            &paths.memory_root(data_root),
            project_id,
            &snapshot.graph,
            cancellation,
            deadline,
        )?
    {
        return Ok(false);
    }
    Ok(true)
}

pub(super) fn fingerprint(snapshot: &ProjectCapsuleSourceSnapshot) -> CognitionResult<String> {
    let bytes =
        serde_json::to_vec(snapshot).map_err(|_| error("project_capsule_source_invalid"))?;
    let digest = Sha256::digest(bytes);
    Ok(format!("{digest:x}"))
}

fn json_text(value: Option<&Value>) -> CognitionResult<String> {
    serde_json::to_string(&value).map_err(|_| error("project_capsule_source_invalid"))
}
