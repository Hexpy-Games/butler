use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::{PlanRecordRead, ProjectLedgerReadError};

pub(super) fn resolve(
    butler_data: &Path,
    input: &PlanRecordRead,
) -> Result<PathBuf, ProjectLedgerReadError> {
    resolve_workspace(butler_data, &input.workspace_path, &input.app_project_id)
}

pub(super) fn resolve_workspace(
    butler_data: &Path,
    workspace_path: &str,
    app_project_id: &str,
) -> Result<PathBuf, ProjectLedgerReadError> {
    resolve_reference(butler_data, Some(workspace_path), app_project_id, None)
}

pub(super) fn resolve_reference(
    butler_data: &Path,
    workspace_path: Option<&str>,
    app_project_id: &str,
    explicit_ref: Option<&str>,
) -> Result<PathBuf, ProjectLedgerReadError> {
    let projects_root = butler_data.join("project-ledger/projects");
    let explicit_path = explicit_ref
        .map(Path::new)
        .filter(|path| path.is_absolute());
    let explicit_path = explicit_path.map(normalize_absolute);
    if let Some(path) = explicit_path
        .as_ref()
        .filter(|path| path.starts_with(&projects_root))
    {
        canonical_containment(&projects_root, path)?;
        let id = path
            .strip_prefix(&projects_root)
            .ok()
            .and_then(|path| path.components().next())
            .and_then(|part| part.as_os_str().to_str())
            .filter(|id| safe_id(id))
            .ok_or(ProjectLedgerReadError::Resolution(
                "active_project_ledger_unresolved",
            ))?;
        let root = projects_root.join(id);
        file_generation(&root.join("project.json"))?;
        file_generation(&root.join("ledger.jsonl"))?;
        return Ok(root);
    }
    let workspace_path = explicit_path
        .as_ref()
        .and_then(|path| path.to_str())
        .or(workspace_path)
        .unwrap_or("");
    // The source cache key observes this generation before candidate reads.
    file_generation(&projects_root)?;
    let workspace = Path::new(workspace_path);
    let mut values = Vec::new();
    if !workspace_path.is_empty() {
        values.push(json_string(&workspace.join("project.json"), "id"));
        values.push(json_string(&workspace.join("package.json"), "name"));
        values.push(
            workspace
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
        );
    }
    if let Some(reference) = explicit_ref.filter(|value| !Path::new(value).is_absolute()) {
        values.push(Some(reference.to_owned()));
    }
    values.push(Some(app_project_id.to_owned()));
    let mut seen = HashSet::new();
    let candidates: Vec<_> = values
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let id = crate::public_text::trim_js_whitespace(&value);
            (safe_id(id) && seen.insert(id.to_owned())).then(|| id.to_owned())
        })
        .map(|id| projects_root.join(id))
        .collect();
    for candidate in &candidates {
        canonical_containment(&projects_root, candidate)?;
    }
    let mut initialized = Vec::new();
    for candidate in &candidates {
        if candidate.join("project.json").exists() && candidate.join("ledger.jsonl").exists() {
            initialized.push(candidate);
        }
    }
    let selected = initialized
        .first()
        .copied()
        .or_else(|| candidates.first())
        .ok_or(ProjectLedgerReadError::Resolution(
            "active_project_ledger_unresolved",
        ))?;
    if workspace_path.is_empty() && explicit_ref.is_none_or(|value| Path::new(value).is_absolute())
    {
        return Err(ProjectLedgerReadError::Resolution(
            "active_project_ledger_unresolved",
        ));
    }
    // buildReference observes these, even though Guided Turn uses only ledger_root.
    file_generation(&selected.join("project.json"))?;
    file_generation(&selected.join("ledger.jsonl"))?;
    Ok(selected.clone())
}

pub(super) fn safe_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 120
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte))
}

fn json_string(path: &Path, key: &str) -> Option<String> {
    let raw = fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let json: Value = serde_json::from_str(&text).ok()?;
    let value = json.get(key)?.as_str()?;
    let value = crate::public_text::trim_js_whitespace(value);
    (!value.is_empty()).then(|| value.to_owned())
}

fn file_generation(path: &Path) -> Result<(), ProjectLedgerReadError> {
    if path.exists() {
        fs::metadata(path)
            .map_err(|_| ProjectLedgerReadError::Resolution("active_project_ledger_unresolved"))?;
    }
    Ok(())
}

pub(super) fn canonical_containment(
    root: &Path,
    candidate: &Path,
) -> Result<(), ProjectLedgerReadError> {
    if !candidate.starts_with(root) {
        return Err(ProjectLedgerReadError::Resolution(
            "active_project_ledger_path_escape",
        ));
    }
    let real_root = realpath_when_present(root)?;
    let real_candidate = realpath_when_present(candidate)?;
    if !real_candidate.starts_with(&real_root) {
        return Err(ProjectLedgerReadError::Resolution(
            "active_project_ledger_path_escape",
        ));
    }
    Ok(())
}

fn realpath_when_present(path: &Path) -> Result<PathBuf, ProjectLedgerReadError> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|_| ProjectLedgerReadError::Resolution("active_project_ledger_path_escape"));
    }
    let parent = path.parent().ok_or(ProjectLedgerReadError::Resolution(
        "active_project_ledger_path_escape",
    ))?;
    if parent == path || path.components().next() == Some(Component::CurDir) {
        return Err(ProjectLedgerReadError::Resolution(
            "active_project_ledger_path_escape",
        ));
    }
    Ok(realpath_when_present(parent)?.join(path.file_name().ok_or(
        ProjectLedgerReadError::Resolution("active_project_ledger_path_escape"),
    )?))
}

fn normalize_absolute(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(part.as_os_str()),
        }
    }
    normalized
}
