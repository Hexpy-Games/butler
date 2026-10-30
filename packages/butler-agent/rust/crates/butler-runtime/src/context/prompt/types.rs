use std::path::PathBuf;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::context::PromptClock;
use butler_turn::btcc::ContextSection;
pub use butler_turn::context_ports::{ContextFuture, ProfilePromptPort, PromptProjectionInput};
use butler_turn::workspace::StoredSessionBinding;

#[derive(Clone, Debug, Default)]
pub struct PromptEnvironment {
    pub response_language_override: Option<String>,
    pub response_language: Option<String>,
    pub user_geo: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PromptPaths {
    pub resource_root: PathBuf,
    pub data_root: PathBuf,
    pub memory_rules_root: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectCapsuleStatus {
    Skipped,
    Present,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopedFeedbackProjection {
    pub scope_kind: String,
    pub content: String,
}

/// A complete active rule from the memory owner, selected for this binding.
#[derive(Clone, Debug)]
pub struct RememberedRuleProjection {
    pub scope_session_id: Option<String>,
    pub expires_at: Option<String>,
    pub handle: String,
    pub text: String,
    pub project_id: Option<String>,
    pub revision: String,
}

pub trait CognitionPromptPort: Send + Sync {
    fn remembered_rules<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
        rules_root: &'a std::path::Path,
    ) -> ContextFuture<'a, Vec<RememberedRuleProjection>>;

    fn scoped_feedback<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Vec<ScopedFeedbackProjection>>;
    fn generation_hot_cache<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    /// `input.session_id` is the canonical conversation-store id for this projection.
    fn session_continuity<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    fn project_capsule<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    fn project_capsule_status<'a>(
        &'a self,
        binding: &'a StoredSessionBinding,
        cancellation: &'a CancellationToken,
    ) -> ContextFuture<'a, ProjectCapsuleStatus>;
}

pub struct PromptDependencies {
    pub profile: Arc<dyn ProfilePromptPort>,
    pub cognition: Arc<dyn CognitionPromptPort>,
    pub clock: Arc<dyn PromptClock>,
}

pub(crate) struct SharedAssemblyInput<'a> {
    pub(crate) binding: &'a StoredSessionBinding,
    pub(crate) request: &'a butler_turn::btcc::TurnRequest,
    pub(crate) role_configuration: Vec<ContextSection>,
}
