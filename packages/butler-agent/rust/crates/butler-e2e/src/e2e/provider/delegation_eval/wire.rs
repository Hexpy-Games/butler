//! Responses and Anthropic SSE adapters used only by the opt-in evaluation.
use axum::{body::Body, http::Response};
use serde_json::{Value, json};
mod decode;
pub use decode::parse;

pub fn call(name: &str, arguments: &Value) -> Value {
    json!({"type":"function_call","id":"fc_eval","call_id":"call_eval","name":name,
        "arguments":arguments.to_string(),"status":"completed"})
}

pub fn answer(path: &str, call: Option<Value>, text: &str, model: &str) -> Response<Body> {
    let events = if path.ends_with("/messages") {
        anthropic(call, text, model)
    } else {
        responses(call, text, model)
    };
    let mut wire = String::new();
    for (index, mut event) in events.into_iter().enumerate() {
        event["sequence_number"] = json!(index);
        wire.push_str(&format!(
            "event: {}\ndata: {event}\n\n",
            event["type"].as_str().unwrap_or_default()
        ));
    }
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(wire))
        .unwrap_or_default()
}
fn responses(call: Option<Value>, text: &str, model: &str) -> Vec<Value> {
    let item = call.unwrap_or_else(|| {
        json!({"type":"message","id":"msg_eval","role":"assistant",
        "status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
    });
    let delta = if item["type"] == "function_call" {
        json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]})
    } else {
        json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":text})
    };
    vec![
        json!({"type":"response.created","response":{"id":"resp_eval","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        delta,
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_eval","object":"response","model":model,"status":"completed","output":[item],
            "usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":0},"output_tokens":20}}}),
    ]
}
fn anthropic(call: Option<Value>, text: &str, model: &str) -> Vec<Value> {
    let tool = call.is_some();
    let arguments = call
        .as_ref()
        .and_then(|c| c["arguments"].as_str())
        .unwrap_or("{}")
        .to_owned();
    let block = call.map_or_else(
        || json!({"type":"text","text":""}),
        |c| {
            json!({
        "type":"tool_use","id":"toolu_eval","name":c["name"],"input":{}})
        },
    );
    let delta = if tool {
        json!({"type":"input_json_delta","partial_json":arguments})
    } else {
        json!({"type":"text_delta","text":text})
    };
    vec![
        json!({"type":"message_start","message":{"id":"msg_eval","type":"message","role":"assistant",
        "content":[],"model":model,"usage":{"input_tokens":100,"output_tokens":0}}}),
        json!({"type":"content_block_start","index":0,"content_block":block}),
        json!({"type":"content_block_delta","index":0,"delta":delta}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":if tool {"tool_use"} else {"end_turn"}},"usage":{"output_tokens":20}}),
        json!({"type":"message_stop"}),
    ]
}

/// Role markers are taken only from user context, never tool descriptions.
pub fn child(body: &Value) -> bool {
    body["input"]
        .as_array()
        .or_else(|| body["messages"].as_array())
        .into_iter()
        .flatten()
        .filter(|item| item["role"] == "user")
        .any(|item| {
            let content = &item["content"];
            let text = content.as_str().map(str::to_owned).unwrap_or_else(|| {
                content
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            text.lines().any(|line| {
                ["role: steward", "role: worker"].iter().any(|role| {
                    line.starts_with(role)
                        || line.starts_with(&format!("Original request (highest priority): {role}"))
                })
            })
        })
}
