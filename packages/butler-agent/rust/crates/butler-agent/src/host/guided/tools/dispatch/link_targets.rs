//! A path that names a place inside the working folder but leads outside it
//! through a link is replaced with the real place before the access check,
//! the approval card and the operation, so all three name the same target
//! and an approval never covers a place it did not show.
use super::GuidedTools;
use butler_core::tool_protocol::ToolName;
use butler_turn::btcc::{BtccError, ModelRoundToolCall};
use serde_json::{Value, json};

/// The arguments a tool resolves against the working folder, as JSON pointers.
fn path_arguments(call: &ModelRoundToolCall) -> Vec<String> {
    let entries = |key: &'static str| {
        let count = call
            .arguments
            .get(key)
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        (0..count).map(move |index| format!("/{key}/{index}/path"))
    };
    match ToolName::parse(&call.name) {
        Some(ToolName::ReadFile) => entries("requests").collect(),
        Some(ToolName::WriteFile | ToolName::EditFile) => std::iter::once("/path".to_owned())
            .chain(entries("edits"))
            .collect(),
        Some(ToolName::ListFiles | ToolName::GrepFiles) => vec!["/root".into()],
        Some(ToolName::RunCommand | ToolName::PreviewStart) => vec!["/cwd".into()],
        _ => Vec::new(),
    }
}

/// `call` with each path that escapes through a link replaced by its real
/// target, or None when no path does.
pub(super) async fn resolve(
    owner: &GuidedTools,
    call: &ModelRoundToolCall,
) -> Result<Option<ModelRoundToolCall>, BtccError> {
    let mut arguments = Value::Object(call.arguments.clone());
    let requested: Vec<(String, String)> = path_arguments(call)
        .into_iter()
        .filter_map(|pointer| {
            let path = arguments.pointer(&pointer)?.as_str()?.to_owned();
            Some((pointer, path))
        })
        .collect();
    if requested.is_empty() {
        return Ok(None);
    }
    // Without a working folder the tool itself reports why.
    let Ok(root) = owner.current_workspace() else {
        return Ok(None);
    };
    let escaped = tokio::task::spawn_blocking(move || {
        requested
            .into_iter()
            .filter_map(|(pointer, path)| {
                butler_turn::workspace::link_escape(&root, &path).map(|real| (pointer, real))
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| BtccError::relayed("link_target_resolution_failed", error.to_string()))?;
    if escaped.is_empty() {
        return Ok(None);
    }
    for (pointer, real) in escaped {
        if let Some(slot) = arguments.pointer_mut(&pointer) {
            *slot = json!(real.to_string_lossy());
        }
    }
    let Value::Object(arguments) = arguments else {
        return Ok(None);
    };
    Ok(Some(ModelRoundToolCall {
        raw_arguments: butler_core::json::stringify(&Value::Object(arguments.clone())).map_err(
            |error| BtccError::relayed("link_target_resolution_failed", error.to_string()),
        )?,
        arguments,
        ..call.clone()
    }))
}
