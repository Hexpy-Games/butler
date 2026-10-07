use super::*;

pub(super) struct TestSessions;

impl AppSessionWorkspaceProvisioner for TestSessions {
    fn provision(
        &self,
        _: AppSessionWorkspaceSnapshot,
        _: CancellationToken,
    ) -> ApplicationFuture<()> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }

    fn branch_info(
        &self,
        _: AppSessionBranchQuery,
        _: CancellationToken,
    ) -> ApplicationFuture<Value> {
        Box::pin(async {
            Ok(json!({
                "available":false,"workspace_mode":"none","safe_status":"unavailable"
            }))
        })
    }
}

impl AppSessionWorkProgress for TestSessions {
    fn read(&self, _: String) -> ApplicationFuture<Option<AppWorkProgress>> {
        Box::pin(async { Ok(None) })
    }
}

impl AppWorkStreamReader for TestSessions {
    fn list_active(&self, _: AppWorkStreamQuery) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(json!([])) })
    }

    fn reconcile_turn(&self, _: AppWorkStreamTurnOutcome) -> ApplicationFuture<()> {
        Box::pin(async { Ok(()) })
    }
}

impl AppSubsessionPort for TestSessions {
    fn projection(&self, _: String, _: Option<AppSessionViewPage>) -> ApplicationFuture<Value> {
        Box::pin(async { Ok(json!({"steward_children":[],"workers":[]})) })
    }
    fn cancel(&self, _: String, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn resume(&self, _: String, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::internal()) })
    }
    fn read_operation_output_chunks(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> ApplicationFuture<Vec<crate::gateway::OperationOutputChunk>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}
