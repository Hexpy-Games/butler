//! Durable source-shaped completion observation publication.

mod consumer;
#[cfg(test)]
mod format_pin;
mod observation;
mod queue;
mod typed_notice;

pub use consumer::{MemorySyncConsumer, MemorySyncPoll};
pub use typed_notice::TypedMemorySourceNotice;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::cognition::{CognitionPathEnvironment, CognitionResult};

/// A completed conversation turn, published for memory projection.
#[derive(Clone, Debug)]
pub struct CompletionNotice {
    /// Project of the conversation, when any.
    pub project_id: Option<String>,
    /// Runtime session that ran the turn.
    pub runtime_session_id: String,
    /// Conversation session.
    pub conversation_session_id: String,
    /// Turn id.
    pub conversation_turn_id: String,
    /// The user message that started the turn.
    pub inbound_message_id: String,
    /// The public answer.
    pub outbound_message_id: String,
    /// Generation of the turn outcome.
    pub outcome_generation: f64,
    /// When the turn completed.
    pub completed_at: String,
}

/// Publishes completed turns and typed sources to the memory sync queue.
#[derive(Clone)]
pub struct CompletionPublisher {
    memory_root: PathBuf,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
}

impl CompletionPublisher {
    /// A publisher over `data_root`.
    pub fn new(
        data_root: &Path,
        paths: &CognitionPathEnvironment,
        now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            memory_root: paths.memory_root(data_root),
            now_iso,
        }
    }

    /// Queues the turn for memory projection.
    pub fn publish(&self, notice: &CompletionNotice) -> CognitionResult<()> {
        let observation = observation::publish(&self.memory_root, notice)?;
        queue::append(
            &self.memory_root,
            &observation,
            &notice.completed_at,
            &(self.now_iso)(),
        )
    }

    pub(crate) fn now_iso(&self) -> String {
        (self.now_iso)()
    }

    pub(crate) fn publish_typed_source(
        &self,
        notice: &TypedMemorySourceNotice,
    ) -> CognitionResult<String> {
        queue::append_typed(&self.memory_root, notice, &(self.now_iso)())
    }

    pub(crate) fn publish_feedback_quality_exclusion(
        &self,
        feedback_id: &str,
        operation_id: &str,
        revision: &str,
    ) -> CognitionResult<String> {
        queue::append_feedback_quality(
            &self.memory_root,
            feedback_id,
            operation_id,
            revision,
            &(self.now_iso)(),
        )
    }
}
