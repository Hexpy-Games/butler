//! Read current App controls only when a descendant admits a new turn.
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
    let client = crate::host::automation::client::ScheduleClient::active(&endpoint)
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    if let Some(run) = schedule {
        let value = client
            .read(&run.automation_id)
            .await
            .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
        return parse(&value["automation"]["access_mode"]);
    }
    let chat = chat.ok_or_else(invalid)?;
    let id: String = url::form_urlencoded::byte_serialize(chat.peer_id.as_bytes()).collect();
    let value = client
        .request(
            reqwest::Method::GET,
            &format!("/sessions/{id}/controls"),
            None,
        )
        .await
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    parse(&value["controls"]["access_mode"])
}

fn invalid() -> BtccError {
    BtccError::relayed(
        "delegation_parent_controls_invalid",
        "Parent controls are unavailable.",
    )
}
fn parse(value: &serde_json::Value) -> Result<AccessMode, BtccError> {
    value
        .as_str()
        .and_then(AccessMode::parse)
        .ok_or_else(invalid)
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
