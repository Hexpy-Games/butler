//! Process-local delivery of validated answer operations, never a storage write.
use parking_lot::RwLock;
use serde_json::Value;
use std::sync::Arc;

type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// Shared by progress scopes and the active gateway composition.
#[derive(Clone, Default)]
pub struct AnswerDraftPublisher(Arc<RwLock<Option<Sink>>>);

impl AnswerDraftPublisher {
    /// Replaces the active gateway sink; callers capture its owner weakly.
    pub fn set_sink(&self, sink: Sink) {
        *self.0.write() = Some(sink);
    }
    /// Forwards only already validated operations, without opening a database.
    pub fn publish(&self, payload: Value) {
        let sink = self.0.read().clone();
        if let Some(sink) = sink {
            sink(payload);
        }
    }
}
