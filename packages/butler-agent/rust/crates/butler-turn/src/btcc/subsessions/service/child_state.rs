//! Whether a child has ended, and stopping one by its relation alone.
use super::control::SubsessionCancelRequest;
use super::{SubsessionService, error};
use crate::btcc::{BtccCode, BtccError, StoredSubsessionDelegation};
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

    /// Stopped, not merely finished: a late Worker result on a child that closed by
    /// itself still fails visibly, but nothing can use what a stopped child's Workers report.
    pub(super) async fn child_stopped(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<bool, BtccError> {
        let latest = self
            .repository
            .latest_turn(relation.child_session_id.clone())
            .await
            .map_err(BtccError::from)?;
        Ok(latest.is_some_and(|(_, state)| state == "cancelled")
            && self.child_ended(relation).await?)
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
