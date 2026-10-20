//! Ordered assistant messages for local tool-call scenarios.
use super::{Body, Response, State, Value, json, json_response, lock};

pub(super) fn response(state: &State, body: &str) -> Option<Response<Body>> {
    let request: Value = serde_json::from_str(body).ok()?;
    if state.chat.script.is_empty() || !request["tools"].is_array() {
        return None;
    }
    if state.chat.refuse_stream && request["stream"] == true {
        return Some(json_response(
            400,
            &json!({"error": {
                "message":"stream is not supported", "type":"invalid_request_error"
            }}),
        ));
    }
    let next = lock(&state.seen)
        .iter()
        .filter(|seen| {
            seen.path.ends_with("/chat/completions")
                && serde_json::from_str::<Value>(&seen.body)
                    .is_ok_and(|r| r["tools"].is_array() && r["stream"] != true)
        })
        .count()
        .saturating_sub(1);
    let message = state
        .chat
        .script
        .get(next)
        .cloned()
        .unwrap_or_else(|| json!({"role":"assistant","content":state.chat.answer}));
    Some(json_response(
        200,
        &json!({
            "id":"chatcmpl-script", "object":"chat.completion", "created":1_759_000_000,
            "model":request["model"],
            "choices":[{"index":0,"message":message,"finish_reason":
                if message["tool_calls"].is_array() { "tool_calls" } else { "stop" }}],
            "usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}
        }),
    ))
}
