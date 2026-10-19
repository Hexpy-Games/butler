//! `upload` steps take only regular files inside the conversation workspace; the
//! App receives a private copy made from the validated file descriptor. Every upload is always confirmed by the owner.
use super::super::GuidedTools;
use serde_json::{Value, json};
use std::path::Path;

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
    operation: &str,
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
        let inventory = owner
            .binding
            .workspace_reference
            .as_ref()
            .and_then(|r| r.read_inventory());
        // Uploads are consumed by one operation; retained turn deliverables
        // must never share their cleanup lifetime with an upload of that source.
        let turn = &owner.binding.turn_id;
        let scope = format!("{}:{}{}:{operation}", turn.len(), turn, operation.len());
        let (path, copy) = tokio::task::spawn_blocking(move || {
            workspace_file(&root, &data, &scope, &raw, inventory)
        })
        .await
        .unwrap_or(Err("workspace_unavailable"))
        .map_err(|reason| {
            json!({"status":"not_dispatched","reason":reason,
                "recovery":recovery(reason)})
        })?;
        staged.append(copy).map_err(|_| json!({"status":"not_dispatched", "reason":"upload_file_unavailable", "recovery":recovery("upload_file_unavailable")}))?;
        step["value"] = json!(path);
    }
    Ok(staged)
}

fn workspace_file(
    root: &Path,
    data: &Path,
    turn: &str,
    raw: &str,
    inventory: Option<std::sync::Arc<butler_platform::secure_fs::SecretInventory>>,
) -> Result<(String, butler_platform::secure_fs::StagedFiles), &'static str> {
    if raw.trim().is_empty() {
        return Err("upload_path_required");
    }
    let inventory =
        inventory.unwrap_or_else(|| butler_platform::secure_fs::SecretInventory::cached(data));
    let root = inventory
        .canonical_root(root)
        .map_err(|_| "workspace_unavailable")?;
    // The descriptor walk checks links; the turn keeps its selected root spelling.
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
    // The result owns cleanup before it crosses the blocking-task boundary.
    // A cancelled JoinHandle drops this guard even if the copy finishes later.
    let mut staged = butler_platform::secure_fs::StagedFiles::new(data);
    staged.push(path.clone());
    let path = path.to_str().ok_or("upload_path_invalid")?.to_owned();
    Ok((path, staged))
}

fn recovery(reason: &str) -> &'static str {
    match reason {
        "upload_file_not_found" => "Choose an existing file inside the workspace.",
        "upload_not_a_file" => "Choose a regular file, rather than a directory or special file.",
        "upload_sensitive_file" => "Choose an ordinary workspace file outside credential stores.",
        _ => "Use one existing workspace file of at most 100 MB. No steps were dispatched.",
    }
}
