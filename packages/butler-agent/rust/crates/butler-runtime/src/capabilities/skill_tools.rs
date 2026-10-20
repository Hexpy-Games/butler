use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{Value, json};

use super::{CapabilityError, CapabilityInvocation, failure};
use crate::skills::{SkillDefinition, Skills};
use butler_turn::workspace::{PathForm, ReadFileInput, WorkspaceFiles};

pub(super) fn load_definition() -> Value {
    json!({"type":"function","name":"load_skill",
        "description":"Load one installed skill's instructions and relative resource paths. Use a name from the available skills catalog.",
        "parameters":{"type":"object","additionalProperties":false,"properties":{
            "name":{"type":"string"}},"required":["name"]},
        "effectBoundary":"none","concurrencySafe":true,"interruptBehavior":"continue","transcriptVisibility":"visible"})
}

pub(super) fn read_definition() -> Value {
    json!({"type":"function","name":"read_skill_file",
        "description":"Read a bounded text window from a file bundled with an installed skill. Use a relative path returned by load_skill.",
        "parameters":{"type":"object","additionalProperties":false,"properties":{
            "name":{"type":"string"},"relative_path":{"type":"string"},
            "start_line":{"type":"integer","minimum":1},
            "limit_lines":{"type":"integer","minimum":1,"maximum":10000},
            "max_bytes":{"type":"integer","minimum":1,"maximum":262_144}},
            "required":["name","relative_path"]},
        "effectBoundary":"none","concurrencySafe":true,"interruptBehavior":"continue","transcriptVisibility":"visible"})
}

async fn named(
    skills: &Skills,
    input: &CapabilityInvocation<'_>,
) -> Result<Option<SkillDefinition>, CapabilityError> {
    let name = input
        .call
        .pointer("/arguments/name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Ok(None);
    }
    let project = input
        .call
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let catalog = skills
        .runtime_catalog(project)
        .await
        .map_err(|error| CapabilityError::caused(error.code(), error))?;
    Ok(catalog.into_iter().find(|skill| skill.name == name))
}

pub(super) async fn load(
    skills: &Skills,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let Some(skill) = named(skills, &input).await? else {
        return Ok(failure(
            "skill_not_found",
            "No installed skill has that name.",
            "Use a name from list_skills.",
        ));
    };
    let folder = skill
        .file_path
        .parent()
        .ok_or_else(|| CapabilityError::new("skill_path_invalid"))?
        .to_owned();
    let resources = tokio::task::spawn_blocking(move || resource_paths(&folder))
        .await
        .map_err(|error| CapabilityError::caused("skills_job_failed", error))?
        .map_err(|error| CapabilityError::caused("skills_io_failed", error))?;
    Ok(
        json!({"ok":true,"name":skill.name,"instructions":skill.instructions,"resource_files":resources}),
    )
}

fn resource_paths(root: &Path) -> std::io::Result<Vec<String>> {
    let canonical = root.canonicalize()?;
    let mut pending = vec![root.to_owned()];
    let mut files = Vec::new();
    while let Some(folder) = pending.pop() {
        for entry in fs::read_dir(folder)? {
            let entry = entry?;
            let path = entry.path();
            if entry.file_type()?.is_symlink() {
                continue;
            }
            if !path.canonicalize()?.starts_with(&canonical) {
                continue;
            }
            if entry.file_type()?.is_dir() {
                if pending.len() < 256 {
                    pending.push(path);
                }
            } else if entry.file_type()?.is_file()
                && path != root.join("SKILL.md")
                && files.len() < 256
            {
                files.push(
                    path.strip_prefix(root)
                        .unwrap_or(Path::new(""))
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    files.sort();
    Ok(files)
}

pub(super) async fn read(
    skills: &Skills,
    workspace: &WorkspaceFiles,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let Some(skill) = named(skills, &input).await? else {
        return Ok(failure(
            "skill_not_found",
            "No installed skill has that name.",
            "Use a name from list_skills.",
        ));
    };
    let path = input
        .call
        .pointer("/arguments/relative_path")
        .and_then(Value::as_str)
        .unwrap_or("");
    if path.is_empty()
        || Path::new(path).is_absolute()
        || Path::new(path)
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Ok(failure(
            "skill_path_invalid",
            "Skill file path must stay inside the skill folder.",
            "Use a relative path from load_skill.",
        ));
    }
    let root = skill
        .file_path
        .parent()
        .ok_or_else(|| CapabilityError::new("skill_path_invalid"))?;
    let guard = workspace
        .guard(
            root.to_owned(),
            path.to_owned(),
            PathForm::RelativeOnly,
            Vec::new(),
        )
        .await
        .map_err(|error| CapabilityError::caused("skills_io_failed", error))?
        .map_err(|error| CapabilityError::caused("skills_io_failed", error))?;
    if let Some(reason) = guard.reason {
        return Ok(failure(
            reason,
            "Skill file path is not an admitted file.",
            "Use a contained file from load_skill.",
        ));
    }
    let file = root.join(path);
    let meta = tokio::fs::metadata(&file).await;
    if meta.as_ref().is_ok_and(|meta| meta.len() > 1_048_576) {
        return Ok(failure(
            "skill_file_too_large",
            "Skill file exceeds the 1 MiB read limit.",
            "Choose a smaller resource file.",
        ));
    }
    let read = workspace
        .read_one(window_input(root, path, &input.call["arguments"]))
        .await
        .map_err(|error| CapabilityError::caused("skills_io_failed", error))?
        .map_err(|error| CapabilityError::caused("skills_io_failed", error))?;
    Ok(read.result)
}

fn window_input(root: &Path, path: &str, args: &Value) -> ReadFileInput {
    let start_line = args
        .get("start_line")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0);
    let limit_lines = args
        .get("limit_lines")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| (1..=10_000).contains(n));
    let max_bytes = args
        .get("max_bytes")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| (1..=262_144).contains(n))
        .unwrap_or(65_536);
    ReadFileInput {
        root: PathBuf::from(root),
        path: path.to_owned(),
        path_form: PathForm::RelativeOnly,
        protected_roots: Vec::new(),
        start_line,
        limit_lines,
        max_bytes,
        offset_bytes: None,
    }
}
