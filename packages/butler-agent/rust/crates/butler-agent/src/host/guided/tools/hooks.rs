//! Resolve progressive calls for hooks without executing or granting authority.
use butler_turn::btcc::ModelRoundToolCall;
use serde_json::{Map, Value};
use std::borrow::Cow;
pub(super) fn name(call: &ModelRoundToolCall) -> Cow<'_, str> {
    if call.name == "tool_call"
        && let Some(id) = call.arguments.get("id").and_then(Value::as_str)
    {
        if let Some(name) = id
            .trim()
            .strip_prefix("native:")
            .filter(|name| !name.is_empty() && !name.contains(':'))
        {
            return Cow::Borrowed(name);
        }
        if let Some(parsed) = butler_models::mcp_client::parse_mcp_catalog_id(id.trim()) {
            return Cow::Owned(format!("mcp__{}__{}", parsed.server_id, parsed.tool_name));
        }
    }
    Cow::Borrowed(&call.name)
}
pub(super) fn input(call: &ModelRoundToolCall) -> &Map<String, Value> {
    if call.name == "tool_call"
        && let Some(arguments) = call.arguments.get("arguments").and_then(Value::as_object)
    {
        return arguments;
    }
    &call.arguments
}
