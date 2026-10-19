//! `upload` steps take only regular files inside the conversation workspace; the
//! App receives a private copy made from the validated file descriptor. Every upload is always confirmed by the owner.
use super::super::GuidedTools;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    butler_platform::secure_fs::canonicalize(path)
}

const MAX_BYTES: u64 = 100 * 1024 * 1024;
/// Butler state that shares the general chat's data-dir workspace.
const INTERNAL: &[&str] = &[
    "app",
    "agent-runtime",
    "memory",
    "project-ledger",
    "browser",
    "logs",
    "butler.config.json",
];

pub(super) async fn resolve(
    owner: &GuidedTools,
    args: &mut Value,
) -> Result<butler_platform::secure_fs::StagedFiles, Value> {
    let mut staged = butler_platform::secure_fs::StagedFiles::new(&owner.binding.butler_data);
    let Some(steps) = args["steps"].as_array_mut() else {
        return Ok(staged);
    };
    if !steps.iter().any(|step| step["action"] == "upload") {
        return Ok(staged);
    }
    let root = owner
        .binding
        .workspace_reference
        .as_ref()
        .and_then(|reference| reference.get().ok())
        .unwrap_or_else(|| owner.binding.workspace_path.clone());
    for step in steps.iter_mut().filter(|step| step["action"] == "upload") {
        let raw = step["value"].as_str().unwrap_or("").to_owned();
        let root = root.clone();
        let data = owner.binding.butler_data.clone();
        let turn = owner.binding.turn_id.clone();
        let path = tokio::task::spawn_blocking(move || workspace_file(&root, &data, &turn, &raw))
            .await
            .unwrap_or(Err("workspace_unavailable"))
            .map_err(|reason| {
                json!({"status":"not_dispatched","reason":reason,
                "recovery":recovery(reason)})
            })?;
        staged.push(PathBuf::from(&path));
        step["value"] = json!(path);
    }
    Ok(staged)
}

fn workspace_file(root: &Path, data: &Path, turn: &str, raw: &str) -> Result<String, &'static str> {
    if raw.trim().is_empty() {
        return Err("upload_path_required");
    }
    let root = canonical(root).map_err(|_| "workspace_unavailable")?;
    // Canonical paths resolve `..` and links before the containment check.
    let path = root.join(raw);
    let Ok(relative) = path.strip_prefix(&root) else {
        return Err("upload_outside_workspace");
    };
    if Path::new(raw)
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("upload_outside_workspace");
    }
    // Never offer credentials, keys or Butler's own state, even with approval.
    let relative = relative.to_string_lossy();
    let first = relative.split(['/', '\\']).next().unwrap_or("");
    if butler_turn::workspace::looks_sensitive(&relative)
        || relative
            .split(['/', '\\'])
            .any(|part| part.starts_with('.'))
        || INTERNAL.contains(&first)
    {
        return Err("upload_sensitive_file");
    }
    let inventory = butler_platform::secure_fs::SecretInventory::cached(data);
    let file =
        butler_platform::secure_fs::open_contained(&root, Path::new(relative.as_ref()), &inventory)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => "upload_file_not_found",
                std::io::ErrorKind::InvalidInput | std::io::ErrorKind::NotADirectory => {
                    "upload_not_a_file"
                }
                std::io::ErrorKind::PermissionDenied => "upload_sensitive_file",
                _ => "upload_file_unavailable",
            })?;
    let metadata = file.metadata().map_err(|_| "upload_file_not_found")?;
    if !metadata.is_file() {
        return Err("upload_not_a_file");
    }
    if metadata.len() > MAX_BYTES {
        return Err("upload_too_large");
    }
    let path = butler_platform::secure_fs::stage_file(data, turn, &path, file, MAX_BYTES)
        .map_err(|_| "upload_file_unavailable")?;
    path.to_str()
        .map(str::to_owned)
        .ok_or("upload_path_invalid")
}

fn recovery(reason: &str) -> &'static str {
    match reason {
        "upload_file_not_found" => "Choose an existing file inside the workspace.",
        "upload_not_a_file" => "Choose a regular file, rather than a directory or special file.",
        "upload_sensitive_file" => "Choose an ordinary workspace file outside credential stores.",
        _ => "Use one existing workspace file of at most 100 MB. No steps were dispatched.",
    }
}
