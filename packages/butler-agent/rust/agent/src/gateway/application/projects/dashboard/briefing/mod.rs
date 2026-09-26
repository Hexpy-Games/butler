mod generation;
mod owner;
mod pack;
mod store;

use owner::BriefingState;
pub(crate) use owner::ProjectDashboardBriefingOwner;

use serde_json::Value;

use super::super::{AppApplication, GatewayApplicationError};
use super::contracts::AppProjectDashboardBriefingRequest;

pub(super) async fn read(
    application: &AppApplication,
    project_id: &str,
) -> Result<Value, GatewayApplicationError> {
    store::read(application, project_id).await
}

pub(super) async fn request(
    application: &AppApplication,
    project_id: &str,
    request: AppProjectDashboardBriefingRequest,
) -> Result<Value, GatewayApplicationError> {
    store::request(application, project_id, request).await
}
