use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::btcc::ContextSection;
use crate::context::{ContextResult, PromptClock};
use crate::workspace::StoredSessionBinding;

pub(crate) type ContextFuture<'a, T> = Pin<Box<dyn Future<Output = ContextResult<T>> + Send + 'a>>;

#[derive(Clone, Debug, Default)]
pub(crate) struct PromptEnvironment {
    pub(crate) response_language_override: Option<String>,
    pub(crate) response_language: Option<String>,
    pub(crate) user_geo: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PromptPaths {
    pub(crate) resource_root: PathBuf,
    pub(crate) data_root: PathBuf,
    pub(crate) cognition_root: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProjectCapsuleStatus {
    Skipped,
    Present,
    Missing,
}

pub(crate) struct PromptProjectionInput<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) project_id: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopedFeedbackProjection {
    pub(crate) scope_kind: String,
    pub(crate) content: String,
}

pub(crate) trait ProfilePromptPort: Send + Sync {
    fn naming_profile<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    fn runtime_profile<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
    fn first_chat_onboarding<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
        locale: &'a str,
    ) -> ContextFuture<'a, Option<String>>;
}

pub(crate) trait CognitionPromptPort: Send + Sync {
    fn scoped_feedback<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Vec<ScopedFeedbackProjection>>;
    fn generation_hot_cache<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>>;
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

pub(crate) struct PromptDependencies {
    pub(crate) profile: Arc<dyn ProfilePromptPort>,
    pub(crate) cognition: Arc<dyn CognitionPromptPort>,
    pub(crate) clock: Arc<dyn PromptClock>,
}

pub(crate) struct SharedAssemblyInput<'a> {
    pub(crate) binding: &'a StoredSessionBinding,
    pub(crate) request: &'a crate::btcc::TurnRequest,
    pub(crate) role_configuration: Vec<ContextSection>,
}
