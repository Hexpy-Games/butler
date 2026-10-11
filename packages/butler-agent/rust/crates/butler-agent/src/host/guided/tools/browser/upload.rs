//! `upload` steps take only regular files inside the conversation workspace; the
//! App receives the canonical path. Every upload is always confirmed by the owner.
use super::super::GuidedTools;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn canonical(path: &Path) -> std::io::Result<PathBuf> {
    butler_platform::secure_fs::canonicalize(path)
}

const MAX_BYTES: u64 = 100 * 1024 * 1024;
/// Butler state that shares the general chat's data-dir workspace.
const INTERNAL: &[&str] = &[
    "auth",
    "app",
    "agent-runtime",
    "secrets",
    "memory",
    "project-ledger",
    "browser",
    "logs",
    "butler.config.json",
];

pub(super) async fn resolve(owner: &GuidedTools, args: &mut Value) -> Result<(), Value> {
    let Some(steps) = args["steps"].as_array_mut() else {
        return Ok(());
    };
    if !steps.iter().any(|step| step["action"] == "upload") {
        return Ok(());
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
        let path = tokio::task::spawn_blocking(move || workspace_file(&root, &raw))
            .await
            .unwrap_or(Err("workspace_unavailable"))
            .map_err(|reason| json!({"status":"not_dispatched","reason":reason,
                "recovery":"upload takes one existing file inside the conversation workspace (a relative path or an absolute path under it, at most 100 MB). No steps were dispatched."}))?;
        step["value"] = json!(path);
    }
    Ok(())
}

fn workspace_file(root: &Path, raw: &str) -> Result<String, &'static str> {
    if raw.trim().is_empty() {
        return Err("upload_path_required");
    }
    let root = canonical(root).map_err(|_| "workspace_unavailable")?;
    // Canonical paths resolve `..` and links before the containment check.
    let path = canonical(&root.join(raw)).map_err(|_| "upload_file_not_found")?;
    let Ok(relative) = path.strip_prefix(&root) else {
        return Err("upload_outside_workspace");
    };
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
    let metadata = path.metadata().map_err(|_| "upload_file_not_found")?;
    if !metadata.is_file() {
        return Err("upload_not_a_file");
    }
    if metadata.len() > MAX_BYTES {
        return Err("upload_too_large");
    }
    path.to_str()
        .map(str::to_owned)
        .ok_or("upload_path_invalid")
}
