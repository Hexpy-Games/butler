//! Explicit Anthropic breakpoints, applied only after carrier serialization.
use serde_json::{Value, json};

use super::ProviderRequestConfig;

/// Other endpoints require an operator's explicit, exact-URL capability assertion.
/// This also lets stub E2Es exercise the production gate without credentials.
pub(super) fn apply(body: &mut Value, config: &ProviderRequestConfig, diagnostics: Option<&Value>) {
    let official = config.endpoint.scheme() == "https"
        && config.endpoint.host_str() == Some("api.anthropic.com")
        && config.endpoint.port_or_known_default() == Some(443);
    let verified = std::env::var("BUTLER_ANTHROPIC_CACHE_VERIFIED_ENDPOINT")
        .ok()
        .and_then(|value| url::Url::parse(&value).ok())
        .is_some_and(|value| value == config.endpoint);
    let enabled = (official || verified)
        && std::env::var("BUTLER_ANTHROPIC_PROMPT_CACHE").as_deref() != Ok("off");
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        normalize(messages, enabled);
    }
    if !enabled {
        return;
    }
    let long = match std::env::var("BUTLER_ANTHROPIC_CACHE_TTL").as_deref() {
        Ok("5m") => Some(json!({"type":"ephemeral","ttl":"5m"})),
        Ok("1h") | Err(_) => Some(json!({"type":"ephemeral","ttl":"1h"})),
        // Off or an invalid setting disables the long breakpoints.
        Ok(_) => None,
    };
    if let Some(system) = body.get_mut("system")
        && let Some(text) = system.as_str().filter(|text| !text.is_empty())
        && let Some(control) = &long
    {
        *system = json!([{"type":"text","text":text,"cache_control":control}]);
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    if let Some(control) = &long {
        split_history(messages, control, diagnostics);
    }
    if let Some(block) = messages
        .last_mut()
        .and_then(|message| message["content"].as_array_mut())
        .and_then(|content| content.last_mut())
        .filter(|block| cacheable(block))
        && block.get("cache_control").is_none()
    {
        block["cache_control"] = json!({"type":"ephemeral"});
    }
}

fn normalize(messages: &mut [Value], enabled: bool) {
    for message in messages {
        if enabled && let Some(text) = message["content"].as_str() {
            message["content"] = json!([{"type":"text","text":text}]);
        }
        if let Some(blocks) = message["content"].as_array_mut() {
            for block in blocks {
                // Provider echoes must not carry old 5m breakpoints before BP2.
                if let Some(block) = block.as_object_mut() {
                    block.remove("cache_control");
                }
            }
        }
    }
}

fn split_history(messages: &mut [Value], control: &Value, diagnostics: Option<&Value>) {
    let Some(content) = messages
        .iter_mut()
        .find(|message| message["role"] == "user")
        .and_then(|message| message["content"].as_array_mut())
    else {
        return;
    };
    let Some(index) = content.iter().position(|block| block["type"] == "text") else {
        return;
    };
    let Some(text) = content[index]["text"].as_str() else {
        return;
    };
    let Some(boundary) = history_boundary(text, diagnostics) else {
        return;
    };
    if text[..boundary].trim().is_empty() {
        return;
    }
    let stable = json!({"type":"text","text":&text[..boundary],"cache_control":control});
    let volatile = json!({"type":"text","text":&text[boundary..]});
    // Attachments belong to the volatile current request, after the history.
    content[index] = volatile;
    content.insert(0, stable);
}

fn cacheable(block: &Value) -> bool {
    match block["type"].as_str() {
        Some("text") => block["text"].as_str().is_some_and(|text| !text.is_empty()),
        Some("tool_result") => match &block["content"] {
            Value::String(text) => !text.is_empty(),
            Value::Array(content) => !content.is_empty(),
            _ => false,
        },
        Some("tool_use" | "image" | "document") => true,
        _ => false,
    }
}

// Guided prompts already identify their authored sections. Use their offsets so
// quoted headings in documents/history/current requests cannot select BP2.
fn history_boundary(text: &str, diagnostics: Option<&Value>) -> Option<usize> {
    if let Some(diagnostics) = diagnostics {
        if diagnostics["sourcePromptBytes"].as_u64()? != text.len() as u64 {
            return None;
        }
        let mut offset = 0usize;
        for section in diagnostics["inputSections"].as_array()? {
            if section["id"] == "current-turn-heading" {
                return text
                    .get(offset..)
                    .filter(|tail| tail.starts_with("## Current turn context\n"))
                    .map(|_| offset);
            }
            offset = offset
                .checked_add(usize::try_from(section["bytes"].as_u64()?).ok()?)?
                .checked_add(2)?;
        }
        return None;
    }
    text.find("\n## Current turn context\n")
        .map(|index| index + 1)
}
