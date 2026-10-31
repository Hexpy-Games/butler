//! App cancellation uses the addressed child's role and the service's ownership checks.
use super::*;
use butler_turn::btcc::SubsessionCancelRequest;

/// Stops the conversation's own delegations; each one stops its own when it ends.
pub(super) async fn cancel_subtree(
    service: &SubsessionService,
    btcc: &butler_turn::btcc::Btcc,
    root: String,
) -> Result<(), GatewayApplicationError> {
    let relations = service
        .repository()
        .open_delegations_below(root.clone())
        .await
        .map_err(GatewayApplicationError::internal_from)?;
    for (parent, relation) in relations.into_iter().filter(|(parent, _)| *parent == root) {
        // One already past stopping must not keep the rest running.
        if let Err(error) = cancel(service, btcc, parent, relation).await {
            tracing::warn!(%error, "Delegation of a removed conversation was not stopped");
        }
    }
    Ok(())
}

pub(super) async fn cancel(
    service: &SubsessionService,
    btcc: &butler_turn::btcc::Btcc,
    parent_session_id: String,
    relation_id: String,
) -> Result<serde_json::Value, GatewayApplicationError> {
    let child_role = service
        .repository()
        .relation_by_id(relation_id.clone())
        .await
        .map_err(GatewayApplicationError::internal_from)?
        .filter(|row| row.parent_session_id == parent_session_id)
        .map(|row| match row.packet.child_role {
            butler_turn::btcc::ChildRole::Worker => SessionRole::Worker,
            butler_turn::btcc::ChildRole::Steward => SessionRole::Steward,
        })
        .unwrap_or(SessionRole::Steward);
    let accepted = service
        .cancel(SubsessionCancelRequest {
            parent_session_id,
            parent_turn_id: "app-steward-control".into(),
            source_message_id: format!("app-steward-cancel:{relation_id}"),
            relation_id: Some(relation_id),
            safe_title: None,
            child_role,
        })
        .await
        .map_err(|error| map_error(&error))?;
    // Persist the stop request before fencing the running model. The
    // queued stop still owns durable cancellation and result delivery.
    if let Some(turn_id) = accepted["child_turn_id"].as_str() {
        btcc.interrupt_turn(turn_id);
    }
    Ok(accepted)
}
