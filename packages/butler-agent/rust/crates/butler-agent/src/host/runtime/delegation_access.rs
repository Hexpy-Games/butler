//! Read current App controls only when a descendant admits a new turn.
use butler_turn::{
    btcc::{AccessMode, BtccError, stored_binding_access_mode},
    workspace::StoredSessionBinding,
};
use std::sync::Arc;

pub(super) async fn current(
    binding: StoredSessionBinding,
    endpoint: Arc<crate::host::ActiveAppEndpoint>,
) -> Result<AccessMode, BtccError> {
    let Some(chat) = binding
        .transport_bindings
        .iter()
        .find(|b| b.transport == "app")
    else {
        return Ok(stored_binding_access_mode(&binding));
    };
    let client = crate::host::automation::client::ScheduleClient::active(&endpoint)
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    let id: String = url::form_urlencoded::byte_serialize(chat.peer_id.as_bytes()).collect();
    let value = client
        .request(
            reqwest::Method::GET,
            &format!("/sessions/{id}/controls"),
            None,
        )
        .await
        .map_err(|e| BtccError::relayed(e.code().to_owned(), e.message().to_owned()))?;
    value["controls"]["access_mode"]
        .as_str()
        .and_then(AccessMode::parse)
        .ok_or_else(|| {
            BtccError::relayed(
                "delegation_parent_controls_invalid",
                "Parent controls are unavailable.",
            )
        })
}
