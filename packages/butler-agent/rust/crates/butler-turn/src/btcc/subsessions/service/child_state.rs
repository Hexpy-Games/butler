//! Whether a child has ended, and stopping one by its relation alone.
use super::control::SubsessionCancelRequest;
use super::{SubsessionService, error};
use crate::btcc::{BtccCode, BtccError, ChildRole, StoredSubsessionDelegation};
use crate::workspace::SessionRole;
use serde_json::Value;

impl SubsessionService {
    /// A direction continues a child under its relation, so a saved result does
    /// not mean it ended: its latest Turn is over and answered, with nothing to take up.
    pub(super) async fn child_ended(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        let session = &relation.child_session_id;
        let Some((turn, state)) = self
            .repository
            .latest_turn(session.clone())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(false);
        };
        if matches!(state.as_str(), "admitted" | "delivery_committed") {
            return Ok(false);
        }
        Ok(self
            .repository
            .has_turn_result(session.clone(), turn)
            .await
            .map_err(BtccError::from)?
            && !self
                .repository
                .has_pending_direction(relation.relation_id.clone())
                .await
                .map_err(BtccError::from)?)
    }

    /// A Steward continues only the Work its relation follows or its pending
    /// direction's new Work; with both gone it has nothing left to continue.
    pub(super) async fn steward_closed(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        Ok(relation.packet.child_role == ChildRole::Steward
            && self
                .repository
                .open_relation_by_work(relation.root_work_id.clone())
                .await
                .map_err(BtccError::from)?
                .is_none()
            && !self
                .repository
                .has_pending_direction(relation.relation_id.clone())
                .await
                .map_err(BtccError::from)?)
    }

    /// Whether a child turn may start: its delegation's first turn, or any turn
    /// of a child that still has something to continue.
    pub async fn child_turn_admissible(
        &self,
        session: &str,
        turn: &str,
    ) -> Result<bool, BtccError> {
        let Some(relation) = self
            .repository
            .by_child(session.into())
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(true);
        };
        Ok(turn == relation.child_turn_id || !self.steward_closed(&relation).await?)
    }

    /// Cancels the delegation under the role it was created with.
    pub(super) async fn cancel_by_relation(
        &self,
        parent: String,
        relation: String,
        source: &str,
    ) -> Result<Value, BtccError> {
        let child_role = self
            .repository
            .relation_by_id(relation.clone())
            .await
            .map_err(BtccError::from)?
            .ok_or_else(|| error(BtccCode::ActiveStewardRelationNotFound))?
            .packet
            .child_role;
        self.cancel(SubsessionCancelRequest {
            parent_session_id: parent,
            parent_turn_id: "subsession-stopped-parent".into(),
            source_message_id: format!("subsession-stopped:{source}:{relation}"),
            relation_id: Some(relation),
            safe_title: None,
            child_role: match child_role {
                crate::btcc::ChildRole::Worker => SessionRole::Worker,
                crate::btcc::ChildRole::Steward => SessionRole::Steward,
            },
        })
        .await
    }
}
