use butler_e2e::e2e::cassette::{Chunk, ResponseRecord};
use serde_json::{Value, json};
pub(super) fn run(body: &Value) -> Option<ResponseRecord> {
    flow(body, "mcp:helper%2Fnotes:e2e_echo", &json!({}))
}
pub(super) fn command(body: &Value) -> Option<ResponseRecord> {
    flow(
        body,
        "native:run_command",
        &json!({"command":"echo plugin-skill","summary":"Plugin skill command","state_effect":"read_only","timeout_ms":30000}),
    )
}
fn flow(body: &Value, tool: &str, arguments: &Value) -> Option<ResponseRecord> {
    let input = body["input"].as_array()?;
    let done = |id: &str| {
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let (id, name, args) = if !done("plugin_skill") {
        ("plugin_skill", "load_skill", json!({"name":"helper:notes"}))
    } else if !done("plugin_describe") {
        ("plugin_describe", "tool_describe", json!({"ids":[tool]}))
    } else if !done("plugin_call") {
        (
            "plugin_call",
            "tool_call",
            json!({"id":tool,"arguments":arguments}),
        )
    } else {
        return Some(response(
            &json!({"type":"message","id":"plugin_answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
        ));
    };
    Some(response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"status":"completed","arguments":args.to_string()}),
    ))
}
fn response(item: &Value) -> ResponseRecord {
    let mut events = vec![
        json!({"type":"response.created","response":{"id":"resp_artifact","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
    ];
    if item["type"] == "function_call" {
        events.push(json!({"type":"response.function_call_arguments.delta","item_id":item["id"],"output_index":0,"delta":item["arguments"]}));
        events.push(json!({"type":"response.function_call_arguments.done","item_id":item["id"],"output_index":0,"arguments":item["arguments"]}));
    } else {
        events.push(json!({"type":"response.output_text.delta","item_id":item["id"],"output_index":0,"content_index":0,"delta":item["content"][0]["text"]}));
    }
    events.push(json!({"type":"response.output_item.done","output_index":0,"item":item}));
    events.push(json!({"type":"response.completed","response":{"id":"resp_artifact","object":"response","status":"completed",
        "model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}));
    ResponseRecord {
        status: 200,
        headers: vec![],
        chunks: events
            .into_iter()
            .enumerate()
            .map(|(i, mut event)| {
                event["sequence_number"] = json!(i);
                Chunk {
                    delay_ms: 0,
                    text: format!(
                        "event: {}\ndata: {event}\n\n",
                        event["type"].as_str().unwrap()
                    ),
                }
            })
            .collect(),
    }
}
