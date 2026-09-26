use crate::public_text::fixed_regex;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::public_text::trim_js_whitespace;

pub(super) struct BindingMarker {
    pub repository_anchor_path: String,
    pub branch: String,
}

pub(super) fn normalize_ref(value: &str) -> String {
    trim_js_whitespace(value).to_owned()
}

pub(super) fn safe_ref(value: &str, allow_head: bool) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.starts_with("refs/")
        && !value.contains(['\0', '\r', '\n'])
        && (allow_head || value != "HEAD")
        && !["..", "@{", "~", "^"]
            .into_iter()
            .any(|part| value.contains(part))
}

pub(super) fn public_label(branch: &str) -> String {
    format!("session-worktree/{branch}")
        .chars()
        .take(80)
        .collect()
}

pub(crate) fn short_session_worktree_branch(session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"butler.worktree-branch.v1\0session\0");
    hasher.update(session_id.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("butler/s/{}", &digest[..12])
}

pub(super) fn marker(anchor: &str, branch: &str, now: &str) -> Value {
    json!({
        "schema": "butler.session-workspace-binding.v1",
        "ownership": "session",
        "repositoryAnchorPath": anchor,
        "branch": branch,
        "boundAt": now,
    })
}

pub(super) fn read_marker(
    metadata: Option<&Map<String, Value>>,
) -> Result<Option<BindingMarker>, ()> {
    let Some(raw) = metadata.and_then(|metadata| metadata.get("sessionWorkspace")) else {
        return Ok(None);
    };
    let Some(object) = raw.as_object() else {
        return Err(());
    };
    let Some(anchor) = object.get("repositoryAnchorPath").and_then(Value::as_str) else {
        return Err(());
    };
    let Some(branch) = object.get("branch").and_then(Value::as_str) else {
        return Err(());
    };
    let Some(bound_at) = object.get("boundAt").and_then(Value::as_str) else {
        return Err(());
    };
    if object.get("schema").and_then(Value::as_str) != Some("butler.session-workspace-binding.v1")
        || object.get("ownership").and_then(Value::as_str) != Some("session")
        || !Path::new(anchor).is_absolute()
        || normalize_ref(branch).is_empty()
        || !safe_ref(&normalize_ref(branch), false)
        || normalize_ref(bound_at).is_empty()
    {
        return Err(());
    }
    Ok(Some(BindingMarker {
        repository_anchor_path: anchor.into(),
        branch: branch.into(),
    }))
}

fn lexical_resolve(path: &Path) -> std::io::Result<PathBuf> {
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut output = PathBuf::new();
    for component in source.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    Ok(output)
}

pub(super) fn canonical_path(path: &str) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(path).or_else(|_| lexical_resolve(Path::new(path)))
}

fn safe_label(value: &str) -> String {
    let mut output = String::new();
    let mut dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            output.push(ch);
            dash = false;
        } else if !dash {
            output.push('-');
            dash = true;
        }
    }
    let output = output.trim_matches('-');
    let output = if output.is_empty() { "session" } else { output };
    // TS String.slice counts UTF-16 code units; output is ASCII here.
    output.chars().take(48).collect()
}

fn safe_project_label(value: &str) -> String {
    static UNSAFE: OnceLock<Regex> = OnceLock::new();
    let normalized = value.nfkc().collect::<String>().to_lowercase();
    let output = UNSAFE
        .get_or_init(|| fixed_regex(r"[^\p{L}\p{N}._-]+"))
        .replace_all(&normalized, "-");
    let output = output.trim_matches(['.', '_', '-']);
    let output = if output.is_empty() { "project" } else { output };
    output.chars().take(32).collect()
}

pub(super) fn prepare_target(
    data: &Path,
    session: &str,
    branch: &str,
    project: Option<&str>,
) -> std::io::Result<String> {
    let target = deterministic_target(data, session, branch, project)?;
    ensure_target_root(data, &target)?;
    Ok(target)
}

pub(super) fn deterministic_target(
    data: &Path,
    session: &str,
    branch: &str,
    project: Option<&str>,
) -> std::io::Result<String> {
    let data = canonical_path(&data.to_string_lossy())?;
    let worktrees = data.join("worktrees");
    let root = worktrees.join("sessions");
    let mut hasher = Sha256::new();
    hasher.update(session.as_bytes());
    hasher.update(b"\0");
    hasher.update(branch.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let name = if let Some(project) = project.filter(|value| !value.is_empty()) {
        format!("{}-{}", safe_project_label(project), &digest[..16])
    } else {
        format!(
            "{}-{}-{}",
            safe_label(session),
            safe_label(branch),
            &digest[..16]
        )
    };
    let target = root.join(name);
    if !target.starts_with(&data) || target == data {
        return Err(std::io::Error::other("target escape"));
    }
    Ok(target.to_string_lossy().into_owned())
}

pub(super) fn ensure_target_root(data: &Path, target: &str) -> std::io::Result<()> {
    validate_target_root(data, target)?;
    let data = canonical_path(&data.to_string_lossy())?;
    let worktrees = data.join("worktrees");
    let root = worktrees.join("sessions");
    std::fs::create_dir_all(&root)?;
    let actual = canonical_path(&root.to_string_lossy())?;
    if !Path::new(target).starts_with(actual) {
        return Err(std::io::Error::other("target escape"));
    }
    Ok(())
}

pub(super) fn validate_target_root(data: &Path, target: &str) -> std::io::Result<()> {
    let data = canonical_path(&data.to_string_lossy())?;
    let target = PathBuf::from(target);
    let worktrees = data.join("worktrees");
    let root = worktrees.join("sessions");
    if !target.starts_with(&data) || target == data {
        return Err(std::io::Error::other("target escape"));
    }
    for segment in [&worktrees, &root] {
        match std::fs::symlink_metadata(segment) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(std::io::Error::other("symlink root"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let actual = canonical_path(&root.to_string_lossy())?;
    if !target.starts_with(actual) {
        return Err(std::io::Error::other("target escape"));
    }
    Ok(())
}

pub(super) fn occupied(path: &str) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => true,
        Ok(_) => std::fs::metadata(path).is_ok_and(|meta| meta.is_dir() || meta.is_file()),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub(super) fn linked_directory(path: &str) -> bool {
    let path = Path::new(path);
    path.exists()
        && path
            .symlink_metadata()
            .is_ok_and(|meta| !meta.file_type().is_symlink())
        && path.metadata().is_ok_and(|meta| meta.is_dir())
}
