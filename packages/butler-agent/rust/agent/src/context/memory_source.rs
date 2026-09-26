//! Required source-reference boundary for Context reads.

use std::sync::Arc;

use super::ContextResult;

pub(crate) struct MemorySourceCandidate {
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub project_id: Option<String>,
    pub origin_kind: String,
}

pub(crate) struct ResolvedMemorySource {
    pub scalar: Arc<str>,
    pub source_hash: String,
    pub source_kind: String,
    pub conversation_session_id: Option<String>,
    pub conversation_message_id: Option<String>,
    pub basis: String,
}

pub(crate) trait MemorySourceReferencePort: Send + Sync {
    fn resolve(
        &self,
        handle: &str,
        authorize: &dyn Fn(&MemorySourceCandidate) -> bool,
    ) -> ContextResult<ResolvedMemorySource>;
}
