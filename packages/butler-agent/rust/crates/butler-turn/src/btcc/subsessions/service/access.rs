//! Delegation starts at the parent's admitted effective tier, with prior ceilings retained.
use super::{StewardDelegationRequest, SubsessionService};
use crate::btcc::guided_turn::GuidedExecutionPolicy;
use crate::btcc::{AccessMode, BtccError};

impl SubsessionService {
    pub(super) async fn inherit_steward_access(
        &self,
        mut request: StewardDelegationRequest,
    ) -> Result<StewardDelegationRequest, BtccError> {
        request.access_mode = self
            .delegated_access(
                &request.parent_session_id,
                &request.parent_turn_id,
                request.access_mode.clone(),
                request.previous_relation_id.as_deref(),
            )
            .await?;
        Ok(request)
    }

    pub(super) async fn delegated_access(
        &self,
        session: &str,
        turn: &str,
        requested: AccessMode,
        previous: Option<&str>,
    ) -> Result<AccessMode, BtccError> {
        let admitted = self
            .repository
            .parent_turn(turn.into())
            .await?
            .filter(|t| t.session_id == session)
            .ok_or_else(|| {
                BtccError::relayed(
                    "delegation_parent_turn_missing",
                    "Delegating turn is missing.",
                )
            })?;
        let parent = GuidedExecutionPolicy::from_turn(&admitted, "").map_err(|_| {
            BtccError::relayed(
                "delegation_parent_policy_invalid",
                "Delegating turn policy is invalid.",
            )
        })?;
        let mut mode = requested.narrower(parent.access_mode);
        if let Some(previous) = previous {
            let prior = self
                .repository
                .relation_by_id(previous.into())
                .await
                .map_err(BtccError::from)?
                .filter(|r| r.parent_session_id == session)
                .ok_or_else(|| {
                    BtccError::relayed(
                        "delegation_previous_relation_missing",
                        "Previous work is missing.",
                    )
                })?;
            mode = mode.narrower(prior.packet.access_mode);
        }
        Ok(mode)
    }
}
