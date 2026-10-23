//! Responses the provider stopped at their output token limit.
use butler_turn::btcc::{ModelRoundToolCall, ToolCallOrigin};
use serde_json::Value;

use super::super::serialize::Carrier;

/// Whether `response` stopped at the output token limit. A tool call it was
/// still writing (the response's last item) is marked as truncated.
pub(super) fn mark(response: &Value, carrier: Carrier, calls: &mut [ModelRoundToolCall]) -> bool {
    let last = |items: Option<&Value>| {
        items
            .and_then(Value::as_array)
            .and_then(|v| v.last())
            .cloned()
    };
    let (truncated, last_is_call) = match carrier {
        Carrier::Anthropic => (
            response["stop_reason"] == "max_tokens",
            last(response.get("content")).is_some_and(|block| block["type"] == "tool_use"),
        ),
        Carrier::Responses => (
            response["status"] == "incomplete"
                && response.pointer("/incomplete_details/reason")
                    == Some(&Value::from("max_output_tokens")),
            last(response.get("output")).is_some_and(|item| item["type"] == "function_call"),
        ),
        // Chat messages carry their tool calls after the text.
        Carrier::Chat { .. } => (
            response.pointer("/choices/0/finish_reason") == Some(&Value::from("length")),
            true,
        ),
        Carrier::Gemini => (
            response.pointer("/candidates/0/finishReason") == Some(&Value::from("MAX_TOKENS")),
            last(response.pointer("/candidates/0/content/parts"))
                .is_some_and(|part| part.get("functionCall").is_some()),
        ),
    };
    if truncated
        && last_is_call
        && let Some(call) = calls.last_mut()
    {
        call.origin = Some(ToolCallOrigin::Truncated);
    }
    truncated
}
