use butler_e2e::e2e::cassette::{Chunk, ResponseRecord};
use serde_json::{Value, json};
pub(crate) fn run(body: &Value) -> Option<ResponseRecord> {
    let input = body["input"].as_array()?;
    let spec = find_spec(&body["input"]);
    let Some(spec) = spec else {
        return Some(answer());
    };
    let done = |id: &str| {
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let direct =
        butler_e2e::e2e::chatgpt_wire::functions(body).any(|tool| tool["name"] == spec["name"]);
    let (id, name, args) = if direct {
        if done("call_connector") {
            return Some(answer());
        }
        (
            "call_connector",
            spec["name"].as_str()?,
            spec["arguments"].clone(),
        )
    } else if !done("describe_connector") {
        (
            "describe_connector",
            "tool_describe",
            json!({"ids":[format!("native:{}",spec["name"].as_str()?)]}),
        )
    } else if !done("call_connector") {
        (
            "call_connector",
            "tool_call",
            json!({"id":format!("native:{}",spec["name"].as_str()?),"arguments":spec["arguments"]}),
        )
    } else {
        return Some(answer());
    };
    Some(response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"status":"completed","arguments":args.to_string()}),
    ))
}
pub(super) fn send(body: &Value) -> Option<ResponseRecord> {
    let input = body["input"].as_array()?;
    let done = |id: &str| {
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let (id, name, args) = if !done("describe_send") {
        (
            "describe_send",
            "tool_describe",
            json!({"ids":["mcp:source%2Fevents:send"]}),
        )
    } else if !done("send_connector") {
        (
            "send_connector",
            "tool_call",
            json!({"id":"mcp:source%2Fevents:send","arguments":{"recipient":"recipient@example.test"}}),
        )
    } else {
        return Some(answer());
    };
    Some(response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"status":"completed","arguments":args.to_string()}),
    ))
}
pub(super) fn answer() -> ResponseRecord {
    response(
        &json!({"type":"message","id":"connector_answer","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Items received.","annotations":[]}]}),
    )
}
pub(super) fn response(item: &Value) -> ResponseRecord {
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

pub(super) fn slow(_: &Value) -> Option<ResponseRecord> {
    let mut response = answer();
    if let Some(chunk) = response.chunks.first_mut() {
        chunk.delay_ms = 1500;
    }
    Some(response)
}

pub(crate) fn find_spec(value: &Value) -> Option<Value> {
    match value {
        Value::String(text) => {
            // Earlier connector blocks can appear in conversation history.
            let text = text
                .rsplit_once("## Current request\n")
                .map_or(text.as_str(), |(_, current)| current);
            if let Some((_, data)) = text.split_once("<connector-data>\n") {
                let payload = serde_json::Deserializer::from_str(data)
                    .into_iter::<Value>()
                    .next()?
                    .ok()?;
                return find_spec(&payload);
            }
            let (_, tail) = text.rsplit_once("fixture-call:")?;
            serde_json::Deserializer::from_str(tail)
                .into_iter::<Value>()
                .next()?
                .ok()
        }
        Value::Array(items) => items.iter().rev().find_map(find_spec),
        Value::Object(fields) => fields.values().rev().find_map(find_spec),
        _ => None,
    }
}
