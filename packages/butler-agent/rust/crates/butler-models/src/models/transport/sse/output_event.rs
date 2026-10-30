//! Which stream events carry model output. An attempt's first output event
//! arms stall detection; events before it (a role-only chunk, a ping, a
//! "created" or "message_start" event) do not, because servers send those at
//! once and may then spend minutes on prefill. After the first output, every
//! event counts as progress.

use serde_json::Value;

/// A chat completion chunk with text, reasoning or a tool-call delta.
pub(super) fn chat(event: &Value) -> bool {
    event["choices"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|choice| {
            let delta = &choice["delta"];
            ["content", "reasoning_content", "reasoning"]
                .iter()
                .any(|key| delta[*key].as_str().is_some_and(|text| !text.is_empty()))
                || delta["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| !calls.is_empty())
        })
}

/// A Responses event with a text, reasoning or tool-argument delta.
pub(super) fn responses(event: &Value) -> bool {
    event["type"]
        .as_str()
        .is_some_and(|kind| kind.ends_with(".delta"))
}

/// An Anthropic content block starting or growing (text, thinking, tool use).
pub(super) fn anthropic(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("content_block_start" | "content_block_delta")
    )
}

/// A Gemini chunk with at least one content part.
pub(super) fn gemini(event: &Value) -> bool {
    event["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|candidate| {
            candidate["content"]["parts"]
                .as_array()
                .is_some_and(|parts| !parts.is_empty())
        })
}
