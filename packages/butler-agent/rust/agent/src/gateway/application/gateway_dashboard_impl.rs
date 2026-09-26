use super::*;
use crate::gateway::MessageFileRef;

impl crate::gateway::GatewayProjectDashboard for AppApplication {
    fn get_project_dashboard(&self, project_id: String) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move { this.get_project_dashboard_owned(project_id).await })
    }
    fn get_project_dashboard_records(
        &self,
        project_id: String,
        query: AppProjectDashboardRecordsQuery,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_project_dashboard_records_owned(project_id, query)
                .await
        })
    }
    fn get_project_dashboard_materials(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_project_dashboard_materials_owned(project_id, query)
                .await
        })
    }
    fn get_project_dashboard_history(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_project_dashboard_history_owned(project_id, query)
                .await
        })
    }
    fn get_project_dashboard_artifacts(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_project_dashboard_artifacts_owned(project_id, query)
                .await
        })
    }
    fn get_project_dashboard_source(
        &self,
        project_id: String,
        query: AppProjectDashboardSourceQuery,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_project_dashboard_source_owned(project_id, query)
                .await
        })
    }
    fn get_project_dashboard_statistics(
        &self,
        project_id: String,
        query: AppProjectDashboardStatisticsQuery,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.get_project_dashboard_statistics_owned(project_id, query)
                .await
        })
    }
    fn update_project_dashboard_preferences(
        &self,
        project_id: String,
        update: AppProjectDashboardPreferencesUpdate,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.update_project_dashboard_preferences_owned(project_id, update)
                .await
        })
    }
    fn request_project_dashboard_briefing(
        &self,
        project_id: String,
        request: AppProjectDashboardBriefingRequest,
    ) -> ApplicationFuture<Value> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.request_project_dashboard_briefing_owned(project_id, request)
                .await
        })
    }
    fn attach_project_dashboard_artifact(
        &self,
        project_id: String,
        artifact_id: String,
        revision: String,
    ) -> ApplicationFuture<MessageFileRef> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.attach_project_dashboard_artifact_owned(project_id, artifact_id, revision)
                .await
        })
    }
}
