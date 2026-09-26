use std::sync::Arc;

use serde_json::{Map, Value};

use crate::{
    gateway::NativeInboundQueue,
    json::JsonDocument,
    operations::{AutomationEnqueue, AutomationError},
};

pub(crate) struct NativeAutomationQueue(pub(crate) Arc<NativeInboundQueue>);

impl AutomationEnqueue for NativeAutomationQueue {
    fn enqueue(
        &self,
        envelope: Value,
        metadata: Map<String, Value>,
    ) -> Result<(), AutomationError> {
        let document = JsonDocument::from_value(&envelope).map_err(|error| {
            AutomationError::new("automation_envelope_invalid", error.to_string())
        })?;
        self.0
            .enqueue_idempotent_with_metadata(document, metadata)
            .map(|_| ())
            .map_err(|error| AutomationError::new(error.code, error.message))
    }
}
