//! Explicit stub for background meaning extraction on synthetic E2E conversations.
//! Match the complete bundled contract; other memory calls remain strict replay.
use super::super::cassette::{Chunk, ResponseRecord};
use serde_json::{Value, json};
use std::sync::OnceLock;

pub(super) fn matches(request: &Value) -> bool {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    let contract = CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../butler-memory/src/cognition/extraction/contracts-v4.json"
        ))
        .unwrap_or(Value::Null)
    });
    let prompt = request["input"]
        .as_str()
        .or_else(|| request["input"][0]["content"][0]["text"].as_str());
    let input = prompt.and_then(|text| serde_json::from_str::<Value>(text).ok());
    let Some(passages) = input
        .as_ref()
        .and_then(|input| input["parts"].as_array())
        .map(Vec::len)
    else {
        return false;
    };
    let format = &request["text"]["format"];
    format["name"] == "memory_meaning_v4"
        && format["type"] == "json_schema"
        && format["strict"] == true
        && format["schema"] == bounded_schema(&contract["meaning_schema"], passages)
        && request["instructions"] == contract["meaning_instructions"]
}

pub(super) fn response() -> ResponseRecord {
    let text = json!({"status":"processed","entities":[],"items":[],"attributes":[]}).to_string();
    let item = json!({"type":"message","id":"msg_meaning","role":"assistant","status":"completed",
        "content":[{"type":"output_text","text":text,"annotations":[]}]});
    let events = [
        json!({"type":"response.created","response":{"id":"resp_meaning","status":"in_progress","output":[]}}),
        json!({"type":"response.output_item.added","output_index":0,"item":item}),
        json!({"type":"response.output_text.delta","item_id":"msg_meaning","output_index":0,"content_index":0,"delta":text}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"id":"resp_meaning","object":"response","status":"completed",
            "model":"gpt-6-luna","output":[item],"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
    ];
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
                        event["type"].as_str().unwrap_or_default()
                    ),
                }
            })
            .collect(),
    }
}

// The product narrows evidence IDs to the current number of source passages.
// Reconstruct those bounds; the complete schema must match exactly.
fn bounded_schema(schema: &Value, passages: usize) -> Value {
    fn visit(value: &mut Value, passages: usize) {
        match value {
            Value::Object(object) => {
                if let Some(items) = object
                    .get_mut("properties")
                    .and_then(|properties| properties.get_mut("evidence"))
                    .and_then(|evidence| evidence.get_mut("items"))
                    .and_then(Value::as_object_mut)
                {
                    *items = serde_json::Map::from_iter([
                        ("type".into(), json!("integer")),
                        ("minimum".into(), json!(0)),
                        ("maximum".into(), json!(passages.saturating_sub(1))),
                    ]);
                }
                for child in object.values_mut() {
                    visit(child, passages);
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(child, passages);
                }
            }
            _ => {}
        }
    }
    let mut schema = schema.clone();
    visit(&mut schema, passages);
    schema
}
