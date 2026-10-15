use serde_json::{Value, json};

/// Messages requires object inputs when replaying assistant tool blocks.
/// Calls retain the invalid raw arguments so the loop sends a tool error;
/// only wire history is normalized to let the model correct the call.
pub(super) fn normalize(mut content: Vec<Value>) -> Vec<Value> {
    for block in &mut content {
        if block["type"] == "tool_use" && !block["input"].is_object() {
            block["input"] = json!({});
        }
    }
    content
}
