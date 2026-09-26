use super::*;

pub(crate) struct UnprovidedRelocation;

impl AppRelocationHost for UnprovidedRelocation {
    fn inspect(&self, _: String) -> ApplicationFuture<AppRelocationSnapshot> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn ensure_binding(
        &self,
        _: AppRelocationBindingSeed,
    ) -> ApplicationFuture<AppRelocationBinding> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn plan_workspace(
        &self,
        _: AppRelocationWorkspaceRequest,
    ) -> ApplicationFuture<AppRelocationWorkspacePlan> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn prepare_workspace(
        &self,
        _: AppRelocationWorkspacePlan,
    ) -> ApplicationFuture<AppRelocationWorkspacePlan> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn compare_and_set_binding(
        &self,
        _: AppRelocationBindingUpdate,
    ) -> ApplicationFuture<AppRelocationBindingResult> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn sync_conversation_context(&self, _: AppRelocationCanonicalUpdate) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn discard_workspace(&self, _: AppRelocationWorkspacePlan) -> ApplicationFuture<bool> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}
