use super::GuidedTools;
use butler_core::json::JsonDocument;
use butler_turn::btcc::{GuidedInvocation, ModelRoundToolCall, ResolveAsk, ToolExecutionError};
use serde_json::json;

pub(super) async fn execute(
    owner: &GuidedTools,
    invocation: GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
) -> Result<JsonDocument, ToolExecutionError> {
    let result = match serde_json::from_value::<ResolveAsk>(json!(call.arguments)) {
        Ok(input) => {
            let id = input.ask_id.clone();
            let result = owner.authority.resolve_ask(invocation.turn, input).await;
            match result {
                Ok(result) => {
                    if result["ok"] == true {
                        owner.binding.open_asks.lock().remove(&id);
                    }
                    result
                }
                Err(error) if error.code() == "invalid_arguments" => {
                    json!({"ok":false,"error":{"code":"invalid_arguments"}})
                }
                Err(error) => return Err(ToolExecutionError::Integrity(error.into())),
            }
        }
        Err(_) => json!({"ok":false,"error":{"code":"invalid_arguments"}}),
    };
    JsonDocument::from_value(&result).map_err(super::effect::wire_error)
}
