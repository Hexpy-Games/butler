//! Thin Context prompt port over Cognition's tracked source reader.

use std::sync::Arc;

use crate::cognition::{CapsulePresence, CognitionError, NativeCognitionPromptReader};
use crate::context::{
    CognitionPromptPort, ContextError, ContextFuture, ProjectCapsuleStatus, PromptProjectionInput,
    ScopedFeedbackProjection,
};
use crate::workspace::StoredSessionBinding;

pub(crate) struct NativeCognitionPrompt {
    reader: Arc<NativeCognitionPromptReader>,
}

impl NativeCognitionPrompt {
    pub(crate) fn new(reader: Arc<NativeCognitionPromptReader>) -> Self {
        Self { reader }
    }
}

fn error(error: CognitionError) -> ContextError {
    ContextError::new(error.code, error.message)
}

impl CognitionPromptPort for NativeCognitionPrompt {
    fn scoped_feedback<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Vec<ScopedFeedbackProjection>> {
        Box::pin(async move {
            let rows = self
                .reader
                .scoped_feedback(
                    input.session_id.to_owned(),
                    input.project_id.map(str::to_owned),
                )
                .await
                .map_err(error)?;
            Ok(rows
                .into_iter()
                .map(|row| ScopedFeedbackProjection {
                    scope_kind: row.scope_kind,
                    content: row.content,
                })
                .collect())
        })
    }

    fn generation_hot_cache<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            self.reader
                .generation_hot_cache(input.project_id.map(str::to_owned))
                .await
                .map_err(error)
        })
    }

    fn session_continuity<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            self.reader
                .session_continuity(input.session_id.to_owned())
                .await
                .map_err(error)
        })
    }

    fn project_capsule<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            self.reader
                .project_capsule(input.project_id.map(str::to_owned))
                .await
                .map_err(error)
        })
    }

    fn project_capsule_status<'a>(
        &'a self,
        binding: &'a StoredSessionBinding,
        _cancellation: &'a tokio_util::sync::CancellationToken,
    ) -> ContextFuture<'a, ProjectCapsuleStatus> {
        Box::pin(async move {
            match self
                .reader
                .project_capsule_status(binding.project_id.clone())
                .await
                .map_err(error)?
            {
                CapsulePresence::Skipped => Ok(ProjectCapsuleStatus::Skipped),
                CapsulePresence::Present => Ok(ProjectCapsuleStatus::Present),
                CapsulePresence::Missing => Ok(ProjectCapsuleStatus::Missing),
            }
        })
    }
}
