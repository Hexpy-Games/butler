//! Optional generation-bound vector adapter; graph authority remains pinned SQL.

use std::{future::Future, pin::Pin};

use crate::cognition::{
    CognitionResult, MemoryGenerationHandle,
    recall::{RecallRequest, RecallVectorMatches},
};

pub(crate) type RecallVectorFuture<'a> =
    Pin<Box<dyn Future<Output = CognitionResult<RecallVectorMatches>> + Send + 'a>>;

pub(crate) trait NativeRecallVectorPort: Send + Sync {
    /// Search current unit metadata only. The pinned graph repeats currentness.
    fn search<'a>(
        &'a self,
        generation: &'a MemoryGenerationHandle,
        request: &'a RecallRequest,
        deadline_at: i64,
    ) -> RecallVectorFuture<'a>;
}
