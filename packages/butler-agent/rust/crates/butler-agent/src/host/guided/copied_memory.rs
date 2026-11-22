//! Prompt memory on a remote computer comes from the copy the main handed
//! over on its last connect; elsewhere from the local owners.
use std::path::Path;
use std::sync::Arc;

use butler_memory::cognition::CognitionPromptReader;
use butler_memory::profile::ProfileService;
use butler_runtime::context::{
    CognitionPromptPort, ProjectCapsuleStatus, RememberedRuleProjection, ScopedFeedbackProjection,
};
use butler_turn::context_ports::{ContextFuture, ProfilePromptPort, PromptProjectionInput};
use butler_turn::remote_memory;
use butler_turn::workspace::StoredSessionBinding;
use tokio_util::sync::CancellationToken;

use crate::host::CognitionPrompt;

fn remote() -> bool {
    butler_models::models::sealed::is_enabled()
}

pub(in crate::host) fn profile_port(profile: Arc<ProfileService>) -> Arc<dyn ProfilePromptPort> {
    if remote() {
        return Arc::new(CopiedProfile);
    }
    profile
}

pub(in crate::host) fn cognition_port(
    reader: Arc<CognitionPromptReader>,
) -> Arc<dyn CognitionPromptPort> {
    let local = CognitionPrompt::new(reader);
    if remote() {
        return Arc::new(CopiedCognition { local });
    }
    Arc::new(local)
}

struct CopiedProfile;

impl ProfilePromptPort for CopiedProfile {
    fn naming_profile<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        Box::pin(async { Ok(remote_memory::copy().and_then(|copy| copy.naming_profile.clone())) })
    }
    fn runtime_profile<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        Box::pin(async { Ok(remote_memory::copy().and_then(|copy| copy.runtime_profile.clone())) })
    }
    /// The profile is learned on the main only.
    fn first_chat_onboarding<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
        _: &'a str,
    ) -> ContextFuture<'a, Option<String>> {
        Box::pin(async { Ok(None) })
    }
}

struct CopiedCognition {
    local: CognitionPrompt,
}

impl CognitionPromptPort for CopiedCognition {
    fn remembered_rules<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
        _: &'a Path,
    ) -> ContextFuture<'a, Vec<RememberedRuleProjection>> {
        Box::pin(async {
            let now = chrono::Utc::now().to_rfc3339();
            Ok(remote_memory::copy()
                .map(|copy| {
                    copy.rules
                        .iter()
                        .filter(|rule| {
                            rule.expires_at
                                .as_deref()
                                .is_none_or(|at| at > now.as_str())
                        })
                        .map(|rule| RememberedRuleProjection {
                            scope_session_id: None,
                            expires_at: rule.expires_at.clone(),
                            handle: rule.handle.clone(),
                            text: rule.text.clone(),
                            project_id: None,
                            revision: rule.revision.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default())
        })
    }
    fn scoped_feedback<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Vec<ScopedFeedbackProjection>> {
        self.local.scoped_feedback(input)
    }
    fn generation_hot_cache<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.local.generation_hot_cache(input)
    }
    fn session_continuity<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.local.session_continuity(input)
    }
    fn project_capsule<'a>(
        &'a self,
        input: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.local.project_capsule(input)
    }
    fn project_capsule_status<'a>(
        &'a self,
        binding: &'a StoredSessionBinding,
        cancellation: &'a CancellationToken,
    ) -> ContextFuture<'a, ProjectCapsuleStatus> {
        self.local.project_capsule_status(binding, cancellation)
    }
}
