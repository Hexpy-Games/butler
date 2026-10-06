//! Cached work-anchor facts, shared by transcript clones and never persisted.
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::contracts::{ModelRoundMessage, ModelRoundRole, ModelRoundToolCall};

#[derive(Clone, Debug)]
pub struct DerivedFacts {
    pub succeeded: bool,
    pub calls: Vec<(String, String)>,
}

#[derive(Debug)]
struct Cached {
    content: Arc<str>,
    role: ModelRoundRole,
    calls: Option<Vec<ModelRoundToolCall>>,
    derived: Arc<DerivedFacts>,
}

/// Derived state does not participate in message serialization or equality.
#[derive(Clone, Default, Debug)]
pub struct MessageFacts(Arc<Mutex<Option<Cached>>>);

impl PartialEq for MessageFacts {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl ModelRoundMessage {
    /// Parse once per source version. Retaining the source Arc prevents pointer
    /// reuse; role and calls are checked too, including edits on message clones.
    pub fn facts(&self) -> Arc<DerivedFacts> {
        let mut cache = self
            .facts
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(cached) = cache.as_ref()
            && Arc::ptr_eq(&cached.content, &self.content)
            && cached.role == self.role
            && cached.calls == self.tool_calls
        {
            return cached.derived.clone();
        }
        let derived = Arc::new(derive(self));
        *cache = Some(Cached {
            content: self.content.clone(),
            role: self.role,
            calls: self.tool_calls.clone(),
            derived: derived.clone(),
        });
        derived
    }
}

fn derive(message: &ModelRoundMessage) -> DerivedFacts {
    let succeeded = message.role == ModelRoundRole::Tool
        && serde_json::from_str::<Value>(&message.content)
            .ok()
            .is_some_and(|value| {
                value.as_object().and_then(|object| object.get("ok")) == Some(&Value::Bool(true))
            });
    let calls = message
        .tool_calls
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|call| {
            let arguments = serde_json::from_str::<Value>(&call.raw_arguments)
                .ok()
                .and_then(|value| match value {
                    Value::Object(arguments) => Some(arguments),
                    _ => None,
                })
                .unwrap_or_default();
            let normalized =
                butler_core::tool_protocol::normalize_guided_tool_call(&call.name, &arguments);
            (call.id.clone(), normalized.name.into_owned())
        })
        .collect();
    DerivedFacts { succeeded, calls }
}

#[cfg(test)]
pub(super) mod tests;
