//! Mirrors product Responses terminal/item accumulation and call-name projection.
//! See butler-models models/transport/sse/{native/responses.rs,../sse.rs}
//! and models/provider/chatgpt_plan.rs::call_name (private product APIs).
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn parse(bytes: &[u8]) -> Value {
    if let Ok(response) = serde_json::from_slice::<Value>(bytes) {
        return result(
            &response,
            &[],
            response["status"] == "completed" || response["stop_reason"].is_string(),
        );
    }
    let events = events(bytes);
    let mut items = BTreeMap::<u64, Value>::new();
    let mut blocks = BTreeMap::<u64, Value>::new();
    let mut response = json!({});
    let mut complete = false;
    for event in events {
        let index = event["output_index"].as_u64().unwrap_or(0);
        match event["type"].as_str().unwrap_or_default() {
            "response.output_item.added" | "response.output_item.done" => {
                items.insert(index, event["item"].clone());
            }
            "response.function_call_arguments.delta" => {
                if let Some(item) = items.get_mut(&index) {
                    append(item, &event["delta"]);
                }
            }
            "response.completed" | "response.incomplete" | "response.failed" => {
                complete = event["type"] == "response.completed";
                response = event["response"].clone();
            }
            "message_start" => response = event["message"].clone(),
            "content_block_start" => {
                let mut block = event["content_block"].clone();
                if block["type"] == "tool_use" {
                    block["arguments"] = json!("");
                }
                blocks.insert(event["index"].as_u64().unwrap_or(0), block);
            }
            "content_block_delta" => {
                if let Some(block) = blocks.get_mut(&event["index"].as_u64().unwrap_or(0)) {
                    append(block, &event["delta"]["partial_json"]);
                }
            }
            "message_delta" => {
                if let Some(from) = event["usage"].as_object() {
                    if !response["usage"].is_object() {
                        response["usage"] = json!({});
                    }
                    if let Some(to) = response["usage"].as_object_mut() {
                        to.extend(from.clone());
                    }
                }
            }
            "message_stop" => complete = true,
            _ => {}
        }
    }
    let fallback: Vec<_> = if blocks.is_empty() { items } else { blocks }
        .into_values()
        .collect();
    result(&response, &fallback, complete)
}

fn events(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(bytes)
        .replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|frame| {
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            serde_json::from_str(&data).ok()
        })
        .collect()
}

fn append(item: &mut Value, fragment: &Value) {
    if let Some(fragment) = fragment.as_str() {
        item["arguments"] = json!(format!(
            "{}{}",
            item["arguments"].as_str().unwrap_or(""),
            fragment
        ));
    }
}

fn result(response: &Value, fallback: &[Value], complete: bool) -> Value {
    let output = response["output"]
        .as_array()
        .or_else(|| response["content"].as_array())
        .filter(|items| !items.is_empty())
        .map(Vec::as_slice)
        .unwrap_or(fallback);
    let calls: Vec<_> = output
        .iter()
        .filter(|item| matches!(item["type"].as_str(), Some("function_call" | "tool_use")))
        .map(|item| {
            let mut call = item.clone();
            // Exactly the product's projection: never guess other namespace encodings.
            let name = item["name"].as_str().unwrap_or("");
            let name = if item.get("namespace").is_none_or(|ns| ns == "butler") {
                name.strip_prefix("butler.").unwrap_or(name)
            } else {
                name
            };
            call["name"] = json!(name);
            call
        })
        .collect();
    let first = output.first().map(|item| {
        let mut metadata = json!({});
        for field in ["type", "name", "namespace"] {
            if item[field].is_string() {
                metadata[field] = item[field].clone();
            }
        }
        metadata
    });
    let mismatch = calls.is_empty()
        && (has_function_item(&response["usage"]) || output.iter().any(has_function_item));
    json!({"calls":calls,"usage":response["usage"],"complete":complete,
        "first_output_item":first,"extraction_mismatch":mismatch})
}

fn has_function_item(value: &Value) -> bool {
    match value {
        Value::Object(fields) => {
            value["type"] == "function_call"
                || value["id"].as_str().is_some_and(|id| id.starts_with("fc_"))
                || fields.values().any(has_function_item)
        }
        Value::Array(values) => values.iter().any(has_function_item),
        Value::String(value) => value.starts_with("fc_"),
        _ => false,
    }
}
