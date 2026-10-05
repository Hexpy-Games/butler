//! Thin Context prompt port over Cognition's tracked source reader.

use std::sync::Arc;

use butler_memory::cognition::{CapsulePresence, CognitionError, CognitionPromptReader};
use butler_runtime::context::{
    CognitionPromptPort, ContextError, ContextFuture, ProjectCapsuleStatus, PromptProjectionInput,
    RememberedRuleProjection, ScopedFeedbackProjection,
};
use butler_turn::workspace::StoredSessionBinding;

pub(crate) struct CognitionPrompt {
    reader: Arc<CognitionPromptReader>,
}

impl CognitionPrompt {
    pub(crate) fn new(reader: Arc<CognitionPromptReader>) -> Self {
        Self { reader }
    }
}

fn error(error: CognitionError) -> ContextError {
    ContextError::port(error.code(), error.message().clone(), error)
}

impl CognitionPromptPort for CognitionPrompt {
    fn remembered_rules<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
        rules_root: &'a std::path::Path,
    ) -> ContextFuture<'a, Vec<RememberedRuleProjection>> {
        let root = rules_root.to_owned();
        let project = input.project_id.map(str::to_owned);
        let session = input.session_id.to_owned();
        Box::pin(async move {
            let rules = tokio::task::spawn_blocking(move || {
                butler_memory::cognition::list_chat_instructions(
                    &root,
                    project.as_deref(),
                    &session,
                )
            })
            .await
            .map_err(|source| ContextError::port("rule_read_failed", "Rule read failed", source))?
            .map_err(error)?;
            Ok(rules
                .into_iter()
                .map(|rule| RememberedRuleProjection {
                    scope_session_id: rule.scope_session_id,
                    expires_at: rule.expires_at,
                    handle: rule.handle,
                    text: rule.text,
                    project_id: rule.project_id,
                    revision: rule.revision,
                })
                .collect())
        })
    }

    fn scoped_feedback<'a>(
        &'a self,
        _input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Vec<ScopedFeedbackProjection>> {
        Box::pin(async { Ok(Vec::new()) })
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
