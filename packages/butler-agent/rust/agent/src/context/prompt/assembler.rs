use crate::btcc::{AdmissionContextPort, BtccError, ContextAssembly, PortFuture, TurnRequest};
use crate::context::{ContextConversation, ContextResult, RecentConversationInput};
use crate::workspace::StoredSessionBinding;

use super::{PromptDependencies, PromptEnvironment, PromptPaths, SharedAssemblyInput};

pub(crate) struct PromptAssembler {
    pub(super) paths: PromptPaths,
    pub(super) environment: PromptEnvironment,
    pub(super) dependencies: PromptDependencies,
    conversation: ContextConversation,
}

impl PromptAssembler {
    pub(crate) fn new(
        paths: PromptPaths,
        environment: PromptEnvironment,
        dependencies: PromptDependencies,
        conversation: ContextConversation,
    ) -> Self {
        Self {
            paths,
            environment,
            dependencies,
            conversation,
        }
    }

    pub(crate) async fn build_butler_context_assembly(
        &self,
        request: &TurnRequest,
        binding: &StoredSessionBinding,
    ) -> ContextResult<ContextAssembly> {
        self.runtime_assembly(binding, request).await
    }

    pub(crate) async fn build_steward_context_assembly(
        &self,
        request: &TurnRequest,
        binding: &StoredSessionBinding,
    ) -> ContextResult<ContextAssembly> {
        self.shared_assembly(SharedAssemblyInput {
            binding,
            request,
            role_configuration: Vec::new(),
        })
        .await
    }
}

impl AdmissionContextPort for PromptAssembler {
    fn build_butler<'a>(
        &'a self,
        request: &'a TurnRequest,
        binding: &'a StoredSessionBinding,
    ) -> PortFuture<'a, ContextAssembly> {
        Box::pin(async move {
            self.build_butler_context_assembly(request, binding)
                .await
                .map_err(btcc_error)
        })
    }

    fn build_steward<'a>(
        &'a self,
        request: &'a TurnRequest,
        binding: &'a StoredSessionBinding,
    ) -> PortFuture<'a, ContextAssembly> {
        Box::pin(async move {
            self.build_steward_context_assembly(request, binding)
                .await
                .map_err(btcc_error)
        })
    }

    fn include_recent<'a>(
        &'a self,
        request: &'a TurnRequest,
        binding: &'a StoredSessionBinding,
        assembly: ContextAssembly,
    ) -> PortFuture<'a, ContextAssembly> {
        Box::pin(async move {
            crate::context::include_recent_context(
                &self.conversation,
                RecentConversationInput {
                    transport: &request.transport,
                    runtime_session_id: &request.session_id,
                    model_ref: Some(&binding.model_ref),
                    event_id: Some(&request.event_id),
                },
                assembly,
            )
            .await
            .map_err(btcc_error)
        })
    }
}

fn btcc_error(error: crate::context::ContextError) -> BtccError {
    BtccError::relayed(error.code, error.message)
}
