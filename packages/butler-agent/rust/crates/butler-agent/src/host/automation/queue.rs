use std::sync::Arc;

use serde_json::{Map, Value};

use butler_core::json::JsonDocument;
use butler_gateway::gateway::InboundQueue;
use butler_runtime::operations::AutomationCode;
use butler_runtime::operations::AutomationEnqueue;
use butler_runtime::operations::AutomationError;

pub(crate) struct AutomationQueue(pub(crate) Arc<InboundQueue>);

impl AutomationEnqueue for AutomationQueue {
    fn enqueue(
        &self,
        envelope: Value,
        metadata: Map<String, Value>,
    ) -> Result<(), AutomationError> {
        let document = JsonDocument::from_value(&envelope).map_err(|error| {
            AutomationError::new(AutomationCode::AutomationEnvelopeInvalid, error.to_string())
                .with_source(error)
        })?;
        self.0
            .enqueue_idempotent_with_metadata(document, metadata)
            .map(|_| ())
            .map_err(|error| AutomationError::port(error.code(), error.message().clone(), error))
    }
}
