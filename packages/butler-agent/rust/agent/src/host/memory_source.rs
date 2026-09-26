//! Adapt Cognition's source resolver to Context's required read port. Scope and
//! paging remain Context policy; graph authority remains Cognition policy.

use std::path::PathBuf;

use crate::cognition::{CognitionPathEnvironment, NativeMemorySourceReference};
use crate::context::{
    ContextError, ContextResult, MemorySourceCandidate, MemorySourceReferencePort,
    ResolvedMemorySource,
};

pub(crate) struct NativeMemorySourceReader {
    source: NativeMemorySourceReference,
}

impl NativeMemorySourceReader {
    pub(crate) fn new(root: PathBuf, environment: CognitionPathEnvironment) -> Self {
        Self {
            source: NativeMemorySourceReference::new(root, environment),
        }
    }
}

impl MemorySourceReferencePort for NativeMemorySourceReader {
    fn resolve(
        &self,
        handle: &str,
        authorize: &dyn Fn(&MemorySourceCandidate) -> bool,
    ) -> ContextResult<ResolvedMemorySource> {
        let resolved = self
            .source
            .resolve(handle, |candidate| {
                authorize(&MemorySourceCandidate {
                    source_kind: candidate.source_kind.clone(),
                    conversation_session_id: candidate.conversation_session_id.clone(),
                    project_id: candidate.project_id.clone(),
                    origin_kind: candidate.origin_kind.clone(),
                })
            })
            .map_err(|error| ContextError::new(error.code, error.message))?;
        Ok(ResolvedMemorySource {
            scalar: resolved.scalar,
            source_hash: resolved.source_hash,
            source_kind: resolved.source_kind,
            conversation_session_id: resolved.conversation_session_id,
            conversation_message_id: resolved.conversation_message_id,
            basis: resolved.basis,
        })
    }
}
