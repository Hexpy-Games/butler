//! Project dashboard HTTP operations.
use super::*;

/// Project dashboard HTTP operations, backed by the App and Project Ledger owners.
pub trait GatewayProjectDashboard: Send + Sync {
    fn get_project_dashboard(&self, project_id: String) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_records(
        &self,
        project_id: String,
        query: AppProjectDashboardRecordsQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_materials(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_history(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_artifacts(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_source(
        &self,
        project_id: String,
        query: AppProjectDashboardSourceQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn get_project_dashboard_statistics(
        &self,
        project_id: String,
        query: AppProjectDashboardStatisticsQuery,
    ) -> ApplicationFuture<serde_json::Value>;
    fn update_project_dashboard_preferences(
        &self,
        project_id: String,
        update: AppProjectDashboardPreferencesUpdate,
    ) -> ApplicationFuture<serde_json::Value>;
    fn request_project_dashboard_briefing(
        &self,
        project_id: String,
        request: AppProjectDashboardBriefingRequest,
    ) -> ApplicationFuture<serde_json::Value>;
    fn attach_project_dashboard_artifact(
        &self,
        project_id: String,
        artifact_id: String,
        revision: String,
    ) -> ApplicationFuture<MessageFileRef>;
}
