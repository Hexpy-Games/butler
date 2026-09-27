use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use super::Project;

pub(super) struct Candidate {
    pub id: String,
    pub root: PathBuf,
}

pub(super) fn candidates(
    row: &Project,
    projects_root: Option<&Path>,
) -> std::io::Result<Vec<Candidate>> {
    let Some(projects_root) = projects_root else {
        return Ok(Vec::new());
    };
    let workspace = Path::new(&row.workspace_path);
    let basename = absolute(workspace)?
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    let inputs = [
        read_json_string(&workspace.join("project.json"), "id"),
        read_json_string(&workspace.join("package.json"), "name"),
        basename,
        Some(row.safe_path_label.clone()),
        Some(row.workspace_label.clone()),
        Some(row.display_name.clone()),
        Some(row.id.clone()),
    ];
    let mut seen = HashSet::new();
    let mut physical_roots = HashSet::new();
    let mut initialized = Vec::new();
    for input in inputs.iter().flatten() {
        let candidate = trim(input);
        if candidate.is_empty() || !seen.insert(candidate) {
            continue;
        }
        if let Some(root) = initialized_root(projects_root, candidate)
            && physical_roots.insert(root.clone())
        {
            initialized.push(Candidate {
                id: candidate.to_owned(),
                root,
            });
        }
    }
    Ok(initialized)
}

pub(super) fn initialized_root(projects_root: &Path, candidate: &str) -> Option<PathBuf> {
    if !safe_id(candidate) {
        return None;
    }
    let root = projects_root.join(candidate);
    if !root.join("project.json").exists() || !root.join("ledger.jsonl").exists() {
        return None;
    }
    let physical_projects_root = projects_root.canonicalize().ok()?;
    let physical_root = root.canonicalize().ok()?;
    physical_root
        .starts_with(physical_projects_root)
        .then_some(physical_root)
}

pub(super) fn root_available(projects_root: Option<&Path>, candidate: &str) -> bool {
    projects_root.is_none_or(|root| !root.join(candidate).exists())
}

pub(super) fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn read_json_string(path: &Path, key: &str) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let candidate = trim(value.get(key)?.as_str()?);
    (!candidate.is_empty()).then(|| candidate.to_owned())
}

pub(super) fn absolute(path: &Path) -> std::io::Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized)
}

/// ECMAScript trim whitespace, including BOM and excluding NEL.
pub(super) fn trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}
