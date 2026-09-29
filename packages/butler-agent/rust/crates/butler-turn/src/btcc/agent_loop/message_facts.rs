//! Facts a transcript message carries once derived, so the loop reads them
//! instead of parsing the same tool result and call arguments every round.

use std::sync::{Arc, OnceLock};

use serde_json::Value;

use super::contracts::{ModelRoundMessage, ModelRoundRole};

/// What a message says about tool calls and results, derived from its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DerivedFacts {
    /// The content these facts were derived from (identity and length).
    source: (usize, usize),
    /// A tool result that reports `"ok": true`.
    pub succeeded: bool,
    /// The requested calls of an assistant message: provider call id and the
    /// tool name after guided normalization.
    pub calls: Arc<[(String, String)]>,
}

/// The derived facts of one message. Never persisted and never compared:
/// they follow from the message's other fields.
#[derive(Clone, Default)]
pub struct MessageFacts(OnceLock<DerivedFacts>);

impl std::fmt::Debug for MessageFacts {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MessageFacts")
    }
}

impl PartialEq for MessageFacts {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

fn identity(content: &Arc<str>) -> (usize, usize) {
    (Arc::as_ptr(content).cast::<u8>() as usize, content.len())
}

impl ModelRoundMessage {
    /// The facts of this message, derived on first use. A message whose
    /// content was replaced after its facts were derived derives them again.
    pub fn facts(&self) -> DerivedFacts {
        let source = identity(&self.content);
        if let Some(derived) = self.facts.0.get()
            && derived.source == source
        {
            return derived.clone();
        }
        let derived = derive(self, source);
        // A concurrent first use derives the same facts; either result serves.
        let _ = self.facts.0.set(derived.clone());
        derived
    }
}

fn derive(message: &ModelRoundMessage, source: (usize, usize)) -> DerivedFacts {
    let succeeded = message.role == ModelRoundRole::Tool && succeeded(&message.content);
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
    DerivedFacts {
        source,
        succeeded,
        calls,
    }
}

fn succeeded(content: &str) -> bool {
    serde_json::from_str::<Value>(content)
        .ok()
        .is_some_and(|value| {
            value.as_object().and_then(|object| object.get("ok")) == Some(&Value::Bool(true))
        })
}
