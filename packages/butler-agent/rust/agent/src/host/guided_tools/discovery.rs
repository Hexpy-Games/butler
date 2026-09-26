//! Progressive native bridge. The outer call alone owns its journal occurrence.

mod invoke;
mod mcp;

use serde_json::{Map, Value, json};

use crate::btcc::{BtccError, GuidedInvocation, ModelRoundToolCall, ToolExecutionError};
use crate::capabilities::{BridgeCatalogTool, describe_native, search_native};
use crate::json::{JsonDocument, visit_raw_array, visit_raw_object};

use super::NativeGuidedTools;

const SCOPED: &str = "tool is outside the current session's scoped progressive surface";
const RECOVER: &str = "Choose a tool already present in the current native surface, or adjust the structured runtime policy that selects tool profiles.";

pub(super) async fn execute(
    owner: &NativeGuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    outer_call_id: &str,
) -> Result<JsonDocument, ToolExecutionError> {
    match call.name.as_str() {
        "tool_search" => search(owner, &call.arguments, invocation.cancellation).await,
        "tool_describe" => describe(owner, &call.arguments, invocation.cancellation).await,
        "tool_call" => invoke::run(owner, invocation, call, outer_call_id).await,
        _ => Err(integrity("guided_bridge_tool_invalid")),
    }
}

pub(super) fn effective(call: &ModelRoundToolCall) -> (String, Value, Option<String>) {
    if call.name == "tool_call"
        && let Some(id) = call
            .arguments
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
    {
        let name = if crate::mcp_client::parse_mcp_catalog_id(id).is_some() {
            "call_mcp_tool"
        } else {
            id.strip_prefix("native:")
                .filter(|name| !name.is_empty() && !name.contains(':'))
                .unwrap_or("tool_call")
        };
        if let Some(args) = call.arguments.get("arguments").and_then(Value::as_object) {
            return (name.into(), Value::Object(args.clone()), Some(id.into()));
        }
        return (
            name.into(),
            Value::Object(call.arguments.clone()),
            Some(id.into()),
        );
    }
    (
        call.name.clone(),
        Value::Object(call.arguments.clone()),
        None,
    )
}

async fn search(
    owner: &NativeGuidedTools,
    args: &Map<String, Value>,
    signal: &tokio_util::sync::CancellationToken,
) -> Result<JsonDocument, ToolExecutionError> {
    let category = text(args, "category").map(str::to_lowercase);
    let category = match category.as_deref() {
        Some("all" | "any" | "native" | "registry" | "workspace") | None => None,
        Some("shell" | "terminal" | "execution" | "execute") => Some("command"),
        Some("filesystem" | "files") => Some("file"),
        Some(value)
            if matches!(
                value,
                "search"
                    | "data"
                    | "command"
                    | "file"
                    | "work"
                    | "monitoring"
                    | "automation"
                    | "todo"
                    | "memory"
                    | "project"
                    | "skill"
                    | "mcp"
                    | "dispatch"
                    | "control"
            ) =>
        {
            Some(value)
        }
        Some(value) => {
            return encoded(
                &json!({"ok":false,"error":{"code":"invalid_tool_category","message":format!("Unknown tool capability category: {value}")},"invalid_category":value,"invalid_provider":null,"valid_categories":["search","data","command","file","work","monitoring","automation","todo","memory","project","skill","mcp","dispatch","control"],"results":[]}),
            );
        }
    };
    let provider = text(args, "provider").map(str::to_lowercase);
    match provider.as_deref() {
        None | Some("native") => (),
        Some("mcp") => {
            return mcp::search(owner, args, category, signal).await;
        }
        Some("plugin") => {
            return encoded(&bridge_error(
                "unsupported_bridge_provider",
                "Plugin catalog and invocation are not available in this native Turn.",
            ));
        }
        Some(value) => {
            return encoded(
                &json!({"ok":false,"error":{"code":"invalid_tool_provider","message":format!("Unknown tool provider: {value}")},"invalid_category":null,"invalid_provider":value,"results":[]}),
            );
        }
    }
    if category == Some("mcp") {
        return mcp::search(owner, args, category, signal).await;
    }
    let mut filtered = args.clone();
    if let Some(category) = category {
        filtered.insert("category".into(), Value::String(category.into()));
    } else {
        filtered.remove("category");
    }
    let catalog = owner.catalog.snapshot();
    let result = search_native(
        catalog
            .native_tools()
            .filter(|tool| {
                !catalog.hidden_native_bridge_tool(
                    tool.name,
                    owner.binding.enable_project_ledger_effects,
                )
            })
            .map(|tool| projection(owner, tool)),
        &filtered,
    )
    .map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_catalog_json",
            error.to_string(),
        ))
    })?;
    encoded(&result)
}

async fn describe(
    owner: &NativeGuidedTools,
    args: &Map<String, Value>,
    signal: &tokio_util::sync::CancellationToken,
) -> Result<JsonDocument, ToolExecutionError> {
    let ids = args
        .get("ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .fold(Vec::new(), |mut unique, id| {
            if !unique.contains(&id) {
                unique.push(id);
            }
            unique
        });
    if ids.is_empty() {
        return encoded(
            &json!({"ok":false,"descriptions":[],"missing":[],"error":{"code":"invalid_tool_catalog_ids","message":"tool_describe requires at least one catalog id."}}),
        );
    }
    let mut descriptions = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        let Some(name) = id
            .strip_prefix("native:")
            .filter(|name| !name.contains(':'))
        else {
            if id.starts_with("mcp:") {
                match mcp::describe(owner, id, signal).await? {
                    Some(description) => descriptions.push(description),
                    None => missing.push(json!({"id":id,"error":"unknown_tool_catalog_id"})),
                }
                continue;
            }
            if id.starts_with("plugin:") {
                return encoded(&bridge_error(
                    "unsupported_bridge_provider",
                    "Plugin schema and invocation are not available in this native Turn.",
                ));
            }
            missing.push(json!({"id":id,"error":"unknown_tool_catalog_id"}));
            continue;
        };
        let catalog = owner.catalog.snapshot();
        if catalog.hidden_native_bridge_tool(name, owner.binding.enable_project_ledger_effects) {
            missing.push(json!({"id":id,"error":"unknown_tool_catalog_id"}));
            continue;
        }
        if let Some(tool) = catalog.native_tool(name) {
            descriptions.push(describe_native(projection(owner, tool)).map_err(|error| {
                ToolExecutionError::Integrity(BtccError::new(
                    "guided_bridge_catalog_json",
                    error.to_string(),
                ))
            })?);
        } else {
            missing.push(json!({"id":id,"error":"unknown_tool_catalog_id"}));
        }
    }
    encoded(&json!({"ok":missing.is_empty(),"descriptions":descriptions,"missing":missing}))
}

pub(super) fn remember_described(
    owner: &NativeGuidedTools,
    call: &ModelRoundToolCall,
    result: &JsonDocument,
) -> Result<(), ToolExecutionError> {
    if call.name != "tool_describe" {
        return Ok(());
    }
    let Some(array) = result.field("descriptions").map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_result_json",
            error.to_string(),
        ))
    })?
    else {
        return Ok(());
    };
    let mut ids = Vec::new();
    visit_raw_array(array, |description| {
        if !description.trim_start().starts_with('{') {
            return Ok(());
        }
        visit_raw_object(description, |key, value| {
            if key == "\"id\"" {
                let id: String = serde_json::from_str(value)
                    .map_err(|error| crate::json::JsonError::new(error.to_string()))?;
                if !id.is_empty() {
                    ids.push(id);
                }
            }
            Ok(())
        })
    })
    .map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_result_json",
            error.to_string(),
        ))
    })?;
    owner.state.lock().described_ids.extend(ids);
    Ok(())
}

fn projection<'a>(
    owner: &NativeGuidedTools,
    tool: crate::btcc::GuidedCatalogRead<'a>,
) -> BridgeCatalogTool<'a> {
    let configured_disabled = owner.web_session.configured_disabled_reason(tool.name);
    let enabled = configured_disabled.is_none()
        && owner.binding.authorized_names.contains(tool.name)
        && NativeGuidedTools::supports(tool.name)
        && !matches!(tool.name, "tool_search" | "tool_describe" | "tool_call");
    BridgeCatalogTool {
        name: tool.name,
        definition: tool.definition,
        category: tool.category.unwrap_or("control"),
        tags: tool.tags,
        safety_notes: tool.safety_notes,
        enabled,
        disabled_reason: if enabled {
            None
        } else {
            configured_disabled.map(|value| value.0).or(Some(SCOPED))
        },
        recovery_hint: if enabled {
            None
        } else {
            configured_disabled.map(|value| value.1).or(Some(RECOVER))
        },
    }
}

fn text<'a>(args: &'a Map<String, Value>, name: &str) -> Option<&'a str> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}
pub(super) fn bridge_error(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":message,"recoverable":true,
        "next_action":"Treat this bridge result as recoverable model feedback. Choose another enabled tool or adjust arguments before retrying."}})
}
fn encoded(value: &Value) -> Result<JsonDocument, ToolExecutionError> {
    JsonDocument::from_value(value).map_err(|error| {
        ToolExecutionError::Integrity(BtccError::new(
            "guided_bridge_result_json",
            error.to_string(),
        ))
    })
}
fn integrity(code: &'static str) -> ToolExecutionError {
    ToolExecutionError::Integrity(BtccError::new(code, code))
}
