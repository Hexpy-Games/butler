//! The single owner of the ChatGPT plan namespace and stateless wire shape.
pub(super) mod recovery;
pub(super) mod retry;
use super::{ProviderAuth, ProviderRequestConfig};
use serde_json::{Map, Value, json};

pub(super) const FORBIDDEN: &[&str] = &[
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
    "prompt_cache_options",
];
pub(in crate::models) type Memo = Option<(String, String)>;
pub(super) fn memo(config: &ProviderRequestConfig) -> Memo {
    if let ProviderAuth::ChatGptPlan { registration, .. } = &config.auth {
        Some((registration.clone(), config.wire_model.clone()))
    } else {
        None
    }
}
pub(in crate::models) fn clear() {
    recovery::clear();
}

/// P3 changes this encoder and the independent harness encoder together.
fn namespace(tools: Vec<Value>) -> Value {
    let mut wrapper = json!({"type":"namespace", "name":"butler", "description":"Butler tools"});
    wrapper["tools"] = Value::Array(tools);
    wrapper
}
pub(in crate::models) fn call_name(item: &Value) -> &str {
    let name = item["name"].as_str().unwrap_or("");
    if item.get("namespace").is_none_or(|ns| ns == "butler") {
        name.strip_prefix("butler.").unwrap_or(name)
    } else {
        name
    }
}
pub(super) fn history(item: Value) -> Value {
    item
}
pub(super) fn tool_identity(tool: &Value, parent: Option<&Value>) -> Option<String> {
    let kind = tool["type"].as_str()?;
    if kind == "function" {
        let namespace = parent.and_then(|p| p["name"].as_str()).unwrap_or("butler");
        Some(format!("{namespace}/{}", tool["name"].as_str()?))
    } else {
        Some(kind.to_owned())
    }
}
fn unsupported(tool: &Value) -> bool {
    matches!(
        tool["type"].as_str(),
        Some(
            "image_generation"
                | "file_search"
                | "code_interpreter"
                | "computer_use"
                | "computer_use_preview"
                | "mcp"
                | "tool_search"
                | "programmatic_tool_calling"
        )
    )
}
/// Prepare the namespace before stable-prefix ordering hashes the body.
pub(super) fn prepare(body: &mut Map<String, Value>, config: &ProviderRequestConfig) {
    if memo(config).is_none() {
        return;
    }
    body.insert("model".into(), config.metadata.model_id.clone().into());
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        let mut functions = Vec::new();
        let mut kept = Vec::new();
        for tool in std::mem::take(tools) {
            if tool["type"] == "function" {
                functions.push(tool);
            } else if !unsupported(&tool) {
                kept.push(tool);
            }
        }
        if !functions.is_empty() {
            kept.push(namespace(functions));
        }
        *tools = kept;
    }
}
pub(in crate::models) fn finalize(body: &mut Map<String, Value>, memo: &Memo) -> Option<String> {
    let Some(key) = memo else {
        return None;
    };
    body.insert("store".into(), false.into());
    body.insert("stream".into(), true.into());
    if body
        .get("instructions")
        .and_then(Value::as_str)
        .is_none_or(|s| s.trim().is_empty())
    {
        body.insert(
            "instructions".into(),
            "You are Butler, a helpful personal AI assistant.".into(),
        );
    }
    for field in FORBIDDEN {
        body.shift_remove(*field);
    }
    if let Some(input) = body.get_mut("input").and_then(Value::as_array_mut) {
        for item in input {
            if item["role"] == "system" {
                item["role"] = "developer".into();
            }
        }
    }
    body.entry("text")
        .or_insert_with(|| json!({"verbosity":"medium"}));
    Some(recovery::apply(body, key))
}

/// A route migration or a learned capability removal starts a new cache prefix.
pub(super) fn same_prefix(
    previous: &Value,
    current: &Value,
    config: &ProviderRequestConfig,
) -> bool {
    if memo(config).is_none() {
        return true;
    }
    previous["providerId"] == current["providerId"]
        && previous["authMode"] == current["authMode"]
        && previous["serializerContract"] == current["serializerContract"]
        && previous["capabilityMemoRevision"] == current["capabilityMemoRevision"]
}

fn tool_for_path(body: &Value, path: &[recovery::Part]) -> Option<String> {
    use recovery::Part;
    let [Part::Key(root), Part::Index(outer), tail @ ..] = path else {
        return None;
    };
    if root != "tools" {
        return None;
    }
    let tool = body["tools"].get(*outer)?;
    if tool["type"] == "namespace"
        && let [Part::Key(children), Part::Index(index), ..] = tail
        && children == "tools"
    {
        return tool_identity(tool["tools"].get(*index)?, Some(tool));
    }
    tool_identity(tool, None)
}

pub(in crate::models) fn observe_registration(
    path: &std::path::Path,
    registration: Option<String>,
) {
    recovery::observe(path, registration);
}

pub(super) fn bind_identity(identity: &mut Map<String, Value>, config: &ProviderRequestConfig) {
    if let Some(key) = memo(config) {
        identity.insert(
            "capabilityMemoRevision".into(),
            recovery::revision(&key).into(),
        );
    }
}
