//! The attached browser keeps page reads on open tabs, including discovery.
use serde_json::{Map, Value, json};

pub(super) fn tab_only(parameters: &mut Map<String, Value>, description: &mut String) {
    if let Some(properties) = parameters
        .get_mut("properties")
        .and_then(Value::as_object_mut)
    {
        properties.remove("url");
    }
    parameters.insert("required".into(), json!(["tab"]));
    *description = "Read a page as evidence. Pass query with what you need: the passages that answer it come first, each with its chunk and span. Without query the page comes in order. Continue with start_chunk=next_start_chunk. url reads a static document (article, docs, PDF); tab reads an open tab as it shows now and returns unchanged when the page is the same. Script-built pages (stores, listings, dashboards) show their content only in a tab: open them with browser_open first. Navigation, ads and repeated blocks come after the main content. Request reads of different pages, and their continuations, together in one round. ok:false with next_action open_in_tab: read the tab before using anything from it; use another source only if the tab fails too, and report what failed.".into();
}

/// Validate the original reader contract before its host-aware routing guard.
/// Direct calls bypass schema admission so a URL gets a useful recovery hint.
pub(super) fn validate(
    owner: &super::GuidedTools,
    arguments: &Map<String, Value>,
) -> Result<Map<String, Value>, Value> {
    let catalog = owner.catalog.snapshot();
    let Some(tool) = catalog.builtin_tool("web_read") else {
        return Err(json!({"ok":false,"error":{"code":"tool_unavailable"}}));
    };
    butler_turn::btcc::normalize_direct_arguments(
        "web_read",
        &tool.definition["parameters"],
        &Value::Object(arguments.clone()),
    )
    .map_err(|(message, field)| {
        json!({"ok":false,"error":{
            "code":"invalid_arguments","message":message,"field":field,"recoverable":true
        }})
    })
}

pub(super) fn describe(
    tool: butler_runtime::capabilities::BridgeCatalogTool<'_>,
    attached: bool,
) -> Result<Value, butler_turn::btcc::ToolExecutionError> {
    let mut definition = tool.definition.clone();
    if tool.name == "web_read" && attached {
        let mut description = String::new();
        if let Some(parameters) = definition["parameters"].as_object_mut() {
            tab_only(parameters, &mut description);
            definition["description"] = Value::String(description);
        }
    }
    butler_runtime::capabilities::describe_native(butler_runtime::capabilities::BridgeCatalogTool {
        definition: &definition,
        ..tool
    })
    .map_err(|error| {
        butler_turn::btcc::ToolExecutionError::Integrity(butler_turn::btcc::BtccError::relayed(
            "guided_bridge_catalog_json",
            error.to_string(),
        ))
    })
}

pub(super) fn tab_required(args: &Map<String, Value>) -> Option<Value> {
    let tab = args
        .get("tab")
        .and_then(Value::as_str)
        .filter(|tab| !tab.trim().is_empty());
    (tab.is_none() || args.contains_key("url")).then(|| {
        json!({"ok":false,"error":{
            "code":"browser_tab_required", "recoverable":true,
            "message":"Open the page with browser_open first, then read it with web_read {tab}.",
            "next_action":"browser_open"
        }})
    })
}
