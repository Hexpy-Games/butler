//! Durable source-shaped completion observation publication.

mod consumer;
mod observation;
mod queue;
mod typed_notice;

pub(crate) use consumer::{MemorySyncPoll, NativeMemorySyncConsumer};
pub(crate) use typed_notice::TypedMemorySourceNotice;

use std::path::PathBuf;
use std::sync::Arc;

use crate::cognition::{CognitionPathEnvironment, CognitionResult};

#[derive(Clone, Debug)]
pub(crate) struct CompletionNotice {
    pub project_id: Option<String>,
    pub runtime_session_id: String,
    pub conversation_session_id: String,
    pub conversation_turn_id: String,
    pub inbound_message_id: String,
    pub outbound_message_id: String,
    pub outcome_generation: f64,
    pub completed_at: String,
}

#[derive(Clone)]
pub(crate) struct CompletionPublisher {
    memory_root: PathBuf,
    now_iso: Arc<dyn Fn() -> String + Send + Sync>,
}

impl CompletionPublisher {
    pub(crate) fn new(
        data_root: PathBuf,
        paths: CognitionPathEnvironment,
        now_iso: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            memory_root: paths.memory_root(&data_root),
            now_iso,
        }
    }

    pub(crate) fn publish(&self, notice: &CompletionNotice) -> CognitionResult<()> {
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
