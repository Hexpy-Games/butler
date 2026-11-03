//! Explicit handoff of existing files; no user-file mutation.
use super::{GuidedTools, dispatch::encoded};
use butler_core::json::JsonDocument;
use butler_platform::secure_fs;
use butler_turn::btcc::{ModelRoundToolCall, ToolExecutionError};
use serde_json::{Value, json};
use std::path::{Component, Path};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const UNAVAILABLE: &str = "Deliver an existing regular file of at most 10 MB inside the active workspace, or an artifacts/ label from a tool result.";

pub(super) async fn execute(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let workspace = owner.active_workspace_path();
    let data = owner.binding.butler_data.clone();
    let turn = owner.binding.turn_id.clone();
    let inventory = owner
        .binding
        .workspace_reference
        .as_ref()
        .and_then(butler_turn::workspace::WorkspaceReference::read_inventory);
    let lease = secure_fs::StageScope::for_operation(&data, &turn);
    let files = call.arguments.get("files").cloned().unwrap_or(Value::Null);
    let result = tokio::task::spawn_blocking(move || {
        let _lease = lease;
        collect(&workspace, &data, &turn, &files, inventory)
    })
    .await;
    encoded(&result.unwrap_or_else(|_| unavailable("")))
}
fn unavailable(path: &str) -> Value {
    json!({"ok":false,"error":"deliver_file_unavailable","path":path,"message":UNAVAILABLE})
}
fn collect(
    workspace: &Path,
    data: &Path,
    turn: &str,
    files: &Value,
    inventory: Option<std::sync::Arc<secure_fs::SecretInventory>>,
) -> Value {
    let inventory = inventory.unwrap_or_else(|| secure_fs::SecretInventory::cached(data));
    let Some(files) = files.as_array().filter(|f| !f.is_empty() && f.len() <= 12) else {
        return unavailable("");
    };
    let mut artifacts = Vec::new();
    let mut delivered = Vec::new();
    for item in files {
        let path = item["path"].as_str().unwrap_or("");
        let Some(mut artifact) = checked(workspace, data, turn, path, &inventory) else {
            return unavailable(path);
        };
        let title = item["title"]
            .as_str()
            .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path));
        if title.chars().count() > 200 {
            return unavailable(path);
        }
        artifact["title"] = json!(title);
        artifacts.push(artifact);
        delivered.push(json!({"path":path,"title":title}));
    }
    json!({"ok":true,"delivered":delivered,"artifacts":artifacts})
}
fn checked(
    workspace: &Path,
    data: &Path,
    turn: &str,
    label: &str,
    inventory: &secure_fs::SecretInventory,
) -> Option<Value> {
    let label = label.replace('\\', "/");
    let artifact = label.starts_with("artifacts/");
    let raw_root = if artifact { data } else { workspace };
    let root = inventory.canonical_root(raw_root).ok()?;
    let path = Path::new(&label);
    let relative = if path.is_absolute() {
        path.strip_prefix(raw_root)
            .or_else(|_| path.strip_prefix(&root))
            .ok()?
    } else {
        path
    };
    if relative.as_os_str().is_empty() || label.contains('\0') {
        return None;
    }
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    let file = secure_fs::open_contained(&root, relative, inventory).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }
    let target = secure_fs::stage_file(data, turn, &root.join(relative), file, MAX_BYTES).ok()?;
    let source = relative.to_str()?.replace('\\', "/");
    Some(
        json!({"path":source,"staged_path":target.to_str()?.to_owned(),
        "source":source,"deliverable":true,"size_bytes":metadata.len(),"mime_type":super::super::journal::mime_for(&label)}),
    )
}
