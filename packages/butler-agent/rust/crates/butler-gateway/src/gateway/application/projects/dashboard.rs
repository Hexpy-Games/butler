//! App-owned Project Dashboard projection over App SQLite and the required Ledger read port.

mod artifacts;
mod board;
mod briefing;
mod contracts;
mod cursor;
mod history;
mod materials;
mod overview;
mod preferences;
mod project;
mod session_links;
mod source;
mod statistics;

pub(crate) use briefing::ProjectDashboardBriefingOwner;
pub use contracts::{
    AppProjectDashboardActionProgress, AppProjectDashboardBriefingPort,
    AppProjectDashboardBriefingPrompt, AppProjectDashboardBriefingRequest,
    AppProjectDashboardCheckpoint, AppProjectDashboardDisposition, AppProjectDashboardLedgerError,
    AppProjectDashboardLedgerEvent, AppProjectDashboardLedgerFuture,
    AppProjectDashboardLedgerHistory, AppProjectDashboardLedgerPort,
    AppProjectDashboardLedgerRecord, AppProjectDashboardManagedPlan,
    AppProjectDashboardManagedWork, AppProjectDashboardPageQuery, AppProjectDashboardPinRef,
    AppProjectDashboardPreferencesUpdate, AppProjectDashboardRecordsQuery,
    AppProjectDashboardReview, AppProjectDashboardSnapshot, AppProjectDashboardSource,
    AppProjectDashboardSourceQuery, AppProjectDashboardStatisticsQuery, AppProjectDashboardWork,
    AppProjectDashboardWorkHistoryEntry,
};

#[cfg(test)]
pub(crate) use contracts::{TestProjectDashboardBriefing, TestProjectDashboardLedger};

use super::super::{AppApplication, GatewayApplicationError};
use crate::gateway::MessageFileRef;
use crate::gateway::application::wallpapers::WallpaperOrigin;
use serde_json::Value;

impl AppApplication {
    pub(crate) async fn get_project_dashboard_owned(
        &self,
        project_id: String,
    ) -> Result<Value, GatewayApplicationError> {
        overview::get(self, &project_id).await
    }

    pub(crate) async fn get_project_dashboard_records_owned(
        &self,
        project_id: String,
        query: AppProjectDashboardRecordsQuery,
    ) -> Result<Value, GatewayApplicationError> {
        board::get(self, &project_id, query).await
    }

    pub(crate) async fn get_project_dashboard_materials_owned(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> Result<Value, GatewayApplicationError> {
        materials::get(self, &project_id, query).await
    }

    pub(crate) async fn get_project_dashboard_history_owned(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> Result<Value, GatewayApplicationError> {
        history::get(self, &project_id, query).await
    }

    pub(crate) async fn get_project_dashboard_artifacts_owned(
        &self,
        project_id: String,
        query: AppProjectDashboardPageQuery,
    ) -> Result<Value, GatewayApplicationError> {
        artifacts::get(self, &project_id, query).await
    }

    pub(crate) async fn get_project_dashboard_source_owned(
        &self,
        project_id: String,
        query: AppProjectDashboardSourceQuery,
    ) -> Result<Value, GatewayApplicationError> {
        source::get(self, &project_id, query).await
    }

    pub(crate) async fn get_project_dashboard_statistics_owned(
        &self,
        project_id: String,
        query: AppProjectDashboardStatisticsQuery,
    ) -> Result<Value, GatewayApplicationError> {
        statistics::get(self, &project_id, query).await
    }

    pub(crate) async fn update_project_dashboard_preferences_owned(
        &self,
        project_id: String,
        update: AppProjectDashboardPreferencesUpdate,
    ) -> Result<Value, GatewayApplicationError> {
        preferences::update(self, &project_id, update, WallpaperOrigin::User).await
    }

    /// A project's wallpaper: `"inherit"` or its source.
    pub(in crate::gateway::application) async fn project_wallpaper(
        &self,
        project_id: &str,
    ) -> Result<Value, GatewayApplicationError> {
        let project = project::read_project(self, project_id).await?;
        let preferences = project::preferences(&project).map_err(super::super::app_error)?;
        Ok(super::super::settings::project_wallpaper_view(
            preferences.get("wallpaper"),
        ))
    }

    /// Sets a project's wallpaper for `origin`; returns the previous one.
    pub(in crate::gateway::application) async fn set_project_wallpaper(
        &self,
        project_id: &str,
        wallpaper: &Value,
        origin: WallpaperOrigin,
    ) -> Result<Value, GatewayApplicationError> {
        preferences::set_wallpaper(self, project_id, wallpaper, origin).await
    }

    pub(crate) async fn request_project_dashboard_briefing_owned(
        &self,
        project_id: String,
        request: AppProjectDashboardBriefingRequest,
    ) -> Result<Value, GatewayApplicationError> {
        briefing::request(self, &project_id, request).await
    }

    pub(crate) async fn attach_project_dashboard_artifact_owned(
        &self,
        project_id: String,
        artifact_id: String,
        revision: String,
    ) -> Result<MessageFileRef, GatewayApplicationError> {
        artifacts::attach(self, &project_id, &artifact_id, &revision).await
    }
}
