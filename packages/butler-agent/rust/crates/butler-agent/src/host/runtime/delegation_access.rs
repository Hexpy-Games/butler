//! Read current controls through the in-process App owner at child admission.
use butler_turn::{
    btcc::{AccessMode, BtccError, stored_binding_access_mode},
    workspace::StoredSessionBinding,
};
use std::sync::Arc;

pub(super) async fn current(
    binding: StoredSessionBinding,
    endpoint: Arc<crate::host::ActiveAppEndpoint>,
    run: Option<butler_turn::btcc::ScheduleRunContext>,
) -> Result<AccessMode, BtccError> {
    let schedule = run.filter(|r| !r.automation_id.is_empty());
    let chat = binding
        .transport_bindings
        .iter()
        .find(|b| b.transport == "app");
    if schedule.is_none() && chat.is_none() {
        return Ok(stored_binding_access_mode(&binding));
    }
    use butler_gateway::gateway::{GatewayApplication, GatewaySessionControls};
    let application = endpoint.application().await.ok_or_else(|| {
        BtccError::relayed(
            "app_gateway_unavailable",
            "App gateway stopped before becoming ready.",
        )
    })?;
    if let Some(run) = schedule {
        return application
            .get_automation(run.automation_id)
            .await
            .map(|value| value.automation.summary.access_mode)
            .map_err(|e| {
                BtccError::relayed("delegation_parent_controls_unavailable", e.to_string())
            });
    }
    let chat = chat.ok_or_else(invalid)?;
    let value = application
        .get_session_controls_view(chat.peer_id.clone())
        .await
        .map_err(|e| BtccError::relayed("delegation_parent_controls_unavailable", e.to_string()))?;
    AccessMode::parse(&value.controls.access_mode).ok_or_else(invalid)
}

fn invalid() -> BtccError {
    BtccError::relayed(
        "delegation_parent_controls_invalid",
        "Parent controls are unavailable.",
    )
}
/// Assemble turn preparation with current parent controls resolved on demand.
pub(super) fn preparation(
    stores: &super::stores::RuntimeStores,
    repositories: butler_turn::btcc::BtccRepositories,
    observer: Arc<dyn butler_turn::conversation::ConversationAdmissionObserver>,
    context: Arc<dyn butler_turn::btcc::AdmissionContextPort>,
    models: Arc<dyn butler_turn::btcc::AdmissionModelCatalogPort>,
    endpoint: Arc<crate::host::ActiveAppEndpoint>,
) -> Arc<butler_turn::btcc::DefaultTurnPreparation> {
    Arc::new(
        butler_turn::btcc::DefaultTurnPreparation::new(
            stores.bindings.clone(),
            stores.conversations.clone(),
            repositories,
            observer,
            context,
            models,
        )
        .with_parent_access(Arc::new(move |binding, run| {
            Box::pin(current(binding, endpoint.clone(), run))
        })),
    )
}
