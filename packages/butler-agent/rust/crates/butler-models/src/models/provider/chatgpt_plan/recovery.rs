//! Generic param-path recovery. No knowledge of any particular field or tool.
use super::tool_identity;
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
pub(super) enum Part {
    Key(String),
    Index(usize),
}
#[derive(Clone, PartialEq, Eq, serde::Serialize)]
enum Removal {
    Field(Vec<Part>),
    Tool(String),
}
type Key = (String, String);
static MEMO: LazyLock<Mutex<HashMap<Key, Vec<Removal>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(super) fn clear() {
    MEMO.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
}
fn path(param: &str) -> Option<Vec<Part>> {
    let mut result = Vec::new();
    let mut rest = param;
    while !rest.is_empty() {
        if let Some(index) = rest.strip_prefix('[') {
            let (n, tail) = index.split_once(']')?;
            result.push(Part::Index(n.parse().ok()?));
            rest = tail;
        } else {
            let end = rest.find(['.', '[']).unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            result.push(Part::Key(rest[..end].into()));
            rest = &rest[end..];
        }
        if let Some(tail) = rest.strip_prefix('.') {
            if tail.is_empty() {
                return None;
            }
            rest = tail;
        }
    }
    (!result.is_empty()).then_some(result)
}
fn node<'a>(mut value: &'a Value, path: &[Part]) -> Option<&'a Value> {
    for part in path {
        value = match part {
            Part::Key(k) => value.get(k)?,
            Part::Index(n) => value.get(*n)?,
        };
    }
    Some(value)
}
fn classify(body: &Value, param: &str) -> Result<Removal, &'static str> {
    let path = path(param).ok_or("provider_unsupported_capability")?;
    node(body, &path).ok_or("provider_unsupported_capability")?;
    let Some(Part::Key(root)) = path.first() else {
        return Err("provider_unsupported_capability");
    };
    match root.as_str() {
        "input" => Err("provider_unsupported_input"),
        "model" => Err("provider_unsupported_model"),
        "stream" | "store" => Err("provider_unsupported_capability"),
        "tools" => super::tool_for_path(body, &path)
            .map(Removal::Tool)
            .ok_or("provider_unsupported_capability"),
        _ => Ok(Removal::Field(path)),
    }
}
pub(in crate::models::provider) fn rejected(
    error: &mut butler_turn::btcc::ProviderRequestError,
    body: &Value,
    key: &Key,
    retried: bool,
) -> bool {
    if error.status_code != Some(400)
        || error.provider_error_code.as_deref()
            != Some("subscription_sharing_unsupported_capability")
    {
        return false;
    }
    if retried {
        error.code = "provider_unsupported_capability".into();
        error.retryable = false;
        return false;
    }
    let param = error
        .provider_error_details
        .as_deref()
        .and_then(|v| v.get("param"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match classify(body, param) {
        Ok(removal) => {
            let mut memo = MEMO
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let entries = memo.entry(key.clone()).or_default();
            if entries.contains(&removal) {
                error.code = "provider_unsupported_capability".into();
                return false;
            }
            entries.push(removal);
            true
        }
        result => {
            error.code = result
                .err()
                .unwrap_or("provider_unsupported_capability")
                .into();
            error.retryable = false;
            false
        }
    }
}
pub(super) fn apply(body: &mut Map<String, Value>, key: &Key) {
    let entries = MEMO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(key)
        .cloned()
        .unwrap_or_default();
    let mut raw = Value::Object(std::mem::take(body));
    for entry in entries {
        match entry {
            Removal::Field(path) => remove(&mut raw, &path),
            Removal::Tool(identity) => {
                if let Some(tools) = raw["tools"].as_array_mut() {
                    remove_tool(tools, &identity);
                }
            }
        }
    }
    *body = raw.as_object_mut().map(std::mem::take).unwrap_or_default();
}
fn remove(value: &mut Value, path: &[Part]) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut node = value;
    for part in parents {
        let next = match part {
            Part::Key(k) => node.get_mut(k),
            Part::Index(n) => node.get_mut(*n),
        };
        let Some(next) = next else {
            return;
        };
        node = next;
    }
    match last {
        Part::Key(k) => {
            if let Some(map) = node.as_object_mut() {
                map.shift_remove(k);
            }
        }
        Part::Index(n) => {
            if let Some(array) = node.as_array_mut()
                && *n < array.len()
            {
                array.remove(*n);
            }
        }
    }
}
fn remove_tool(tools: &mut Vec<Value>, identity: &str) {
    tools.retain_mut(|tool| {
        if tool_identity(tool, None).as_deref() == Some(identity) {
            return false;
        }
        let parent = tool.clone();
        if let Some(children) = tool.get_mut("tools").and_then(Value::as_array_mut) {
            children
                .retain(|child| tool_identity(child, Some(&parent)).as_deref() != Some(identity));
            if children.is_empty() {
                return false;
            }
        }
        true
    });
}

pub(super) fn revision(key: &Key) -> String {
    use sha2::{Digest, Sha256};
    let entries = MEMO
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(key)
        .cloned()
        .unwrap_or_default();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&entries).unwrap_or_default())
    )
}

static REGISTRATIONS: LazyLock<Mutex<HashMap<std::path::PathBuf, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(super) fn observe(path: &std::path::Path, registration: Option<String>) {
    let mut observed = REGISTRATIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let changed = observed.get(path).is_some_and(|old| *old != registration);
    observed.insert(path.to_owned(), registration);
    drop(observed);
    if changed {
        clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // test-category: pure-logic
    #[test]
    fn resolves_generic_paths_and_enclosing_tools_without_dropping_input() {
        let body = serde_json::json!({"input":[{"text":"keep"}],"model":"m","store":false,
            "feature":{"values":[1,2]}, "tools":[{"type":"namespace","name":"arbitrary","tools":[
                {"type":"function","name":"random-name","parameters":{"type":"object"}}]}]});
        assert!(
            matches!(classify(&body,"tools[0].tools[0].parameters.type"),Ok(Removal::Tool(ref id)) if id == "arbitrary/random-name")
        );
        assert!(matches!(
            classify(&body, "feature.values[1]"),
            Ok(Removal::Field(_))
        ));
        assert_eq!(
            classify(&body, "input[0].text").err(),
            Some("provider_unsupported_input")
        );
        assert_eq!(
            classify(&body, "model").err(),
            Some("provider_unsupported_model")
        );
        assert!(classify(&body, "store").is_err());
        assert!(classify(&body, "missing[0]").is_err());
    }
}
