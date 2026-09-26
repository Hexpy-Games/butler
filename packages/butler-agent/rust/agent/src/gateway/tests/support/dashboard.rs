use super::*;

impl GatewayProjectDashboard for TestApplication {
    fn get_project_dashboard(&self, _: String) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_project_dashboard_records(
        &self,
        _: String,
        _: AppProjectDashboardRecordsQuery,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_project_dashboard_materials(
        &self,
        _: String,
        _: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_project_dashboard_history(
        &self,
        _: String,
        _: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_project_dashboard_artifacts(
        &self,
        _: String,
        _: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_project_dashboard_source(
        &self,
        _: String,
        _: AppProjectDashboardSourceQuery,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn get_project_dashboard_statistics(
        &self,
        _: String,
        _: AppProjectDashboardStatisticsQuery,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn update_project_dashboard_preferences(
        &self,
        _: String,
        _: AppProjectDashboardPreferencesUpdate,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn request_project_dashboard_briefing(
        &self,
        _: String,
        _: AppProjectDashboardBriefingRequest,
    ) -> ApplicationFuture<Value> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
    fn attach_project_dashboard_artifact(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> ApplicationFuture<MessageFileRef> {
        Box::pin(async { Err(GatewayApplicationError::Internal) })
    }
}
