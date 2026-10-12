//! Optional generation-bound vector adapter; graph authority remains pinned SQL.

use std::{future::Future, pin::Pin};

use crate::cognition::{
    CognitionResult, MemoryGenerationHandle,
    recall::{RecallRequest, RecallVectorMatches},
};

/// The pending result of a vector search.
pub type RecallVectorFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<RecallVectorMatches>> + Send + 'a>>;

/// Finds episodes near a recall query in the vector store.
pub trait RecallVectorPort: Send + Sync {
    /// The user's memory-model choice: false means the vector lane is switched
    /// off, not failing. Recall then runs on its text lanes alone.
    fn enabled(&self) -> bool {
        true
    }

    /// Optionally warm a fresh generation without claiming that vectors were searched.
    /// Ports without a model owner leave unconfigured recall unchanged.
    fn warm<'a>(
        &'a self,
        _generation: &'a MemoryGenerationHandle,
        _request: &'a RecallRequest,
        _deadline_at: i64,
    ) -> RecallVectorFuture<'a> {
        Box::pin(async { Ok(RecallVectorMatches::default()) })
    }

    /// Search current unit metadata only. The pinned graph repeats currentness.
    fn search<'a>(
        &'a self,
        generation: &'a MemoryGenerationHandle,
        request: &'a RecallRequest,
        deadline_at: i64,
    ) -> RecallVectorFuture<'a>;
}
