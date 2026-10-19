//! Replay an assistant's entire signed reasoning group only when its normalized
//! request prefix and last kept reasoning predecessor match its production
//! binding. Unbound or invalid groups lose only reasoning; all other content is
//! preserved. Bindings are internal history metadata and never reach the wire.
use butler_turn::btcc::ModelRoundResult;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, serde::Deserialize)]
pub(super) struct Binding {
    prefix: String,
    after: Option<String>,
}

pub(super) fn enforce(body: &mut Value) -> Binding {
    let mut hasher = Sha256::new();
    feed(&mut hasher, &normalized(&body["system"]));
    let mut tools = body["tools"].as_array().cloned().unwrap_or_default();
    tools.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    feed(&mut hasher, &normalized(&Value::Array(tools)));
    let mut last_kept = None;
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        messages.retain_mut(|message| {
            if message["role"] == "assistant"
                && let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut)
                && blocks.iter().any(reasoning)
            {
                let binding = blocks
                    .iter()
                    .find(|block| reasoning(block))
                    .and_then(|block| block.get("butler_binding"))
                    .and_then(|value| serde_json::from_value::<Binding>(value.clone()).ok());
                let keep = binding.is_some_and(|binding| {
                    binding.prefix == digest(&hasher) && binding.after == last_kept
                });
                for block in blocks.iter_mut().filter_map(Value::as_object_mut) {
                    block.remove("butler_binding");
                }
                if keep {
                    if let Some(block) = blocks.iter().rfind(|block| reasoning(block)) {
                        last_kept = Some(id(block));
                    }
                } else {
                    blocks.retain(|block| !reasoning(block));
                }
                if blocks.is_empty() {
                    return false;
                }
            }
            let mut content = message.clone();
            if let Some(blocks) = content.get_mut("content").and_then(Value::as_array_mut) {
                blocks.retain(|block| !reasoning(block));
            }
            feed(&mut hasher, &normalized(&content));
            true
        });
    }
    Binding {
        prefix: digest(&hasher),
        after: last_kept,
    }
}

pub(super) fn bind(result: &mut ModelRoundResult, binding: &Binding) {
    let Some(blocks) = result
        .assistant_message
        .as_mut()
        .and_then(|message| message.provider_data.as_mut())
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    if let Some(block) = blocks.iter_mut().find(|block| reasoning(block)) {
        block["butler_binding"] = serde_json::json!({
            "prefix":binding.prefix,"after":binding.after
        });
    }
}

fn reasoning(block: &Value) -> bool {
    matches!(
        block["type"].as_str(),
        Some("thinking" | "redacted_thinking")
    )
}

fn id(block: &Value) -> String {
    let key = if block["type"] == "thinking" {
        "signature"
    } else {
        "data"
    };
    format!(
        "{:x}",
        Sha256::digest(block[key].as_str().unwrap_or_default().as_bytes())
    )
}

fn digest(hasher: &Sha256) -> String {
    format!("{:x}", hasher.clone().finalize())
}

fn feed(hasher: &mut Sha256, value: &Value) {
    let bytes = value.to_string();
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes.as_bytes());
}

fn normalized(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(key, _)| *key != "cache_control")
                .map(|(key, value)| (key.clone(), normalized(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.iter().map(normalized).collect()),
        _ => value.clone(),
    }
}
