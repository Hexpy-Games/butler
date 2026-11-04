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
            let has_other_tool_result = owner.state.lock().has_other_tool_result;
            if input.ask_id.starts_with("canon:") {
                let result = if let Some(refusal) = butler_turn::btcc::resolve_ask_guard(
                    invocation.turn,
                    has_other_tool_result,
                    &input,
                ) {
                    refusal
                } else {
                    super::canon::request(owner,"resolve",json!({"id":input.ask_id.trim_start_matches("canon:"),"outcome":input.outcome,"by":"chat"})).await
                };
                if result["ok"] == true
                    || matches!(
                        result["error"]["code"].as_str(),
                        Some("canon_conflict" | "canon_not_found")
                    )
                {
                    owner.binding.open_asks.lock().remove(&id);
                }
                return JsonDocument::from_value(&result).map_err(super::effect::wire_error);
            }
            let result = owner
                .authority
                .resolve_ask(invocation.turn, has_other_tool_result, input)
                .await;
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
