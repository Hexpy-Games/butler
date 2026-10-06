//! Closed delegation feedback and trusted context for a fresh assignment.
use super::{StewardDelegationRequest, SubsessionService, error};
use crate::btcc::{BtccCode, BtccError, StoredSubsessionDelegation};
use serde_json::{Value, json};

impl SubsessionService {
    pub(super) async fn closed_feedback(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<Value, BtccError> {
        let prior = self.prior_context(relation).await?;
        Ok(json!({"ok":false,"error":{
            "code":"delegated_session_closed","recoverable":true,
            "message":"The prior delegated Work is closed. For a new user request, continue in this same turn: start a new Work, record and review its Steward Plan, then delegate_to_steward with previous_relation_id. Do not ask the user to restart or end with a connection notice. An acceptance/closeout request for already closed Work needs no replacement. No child was steered."
        },"next_action":{"tool":"delegate_to_steward",
            "previous_relation_id":relation.relation_id,
            "requires":["start_work","replace_work_plan","record_work_review"]},
            "prior_context":prior}))
    }

    async fn prior_context(
        &self,
        relation: &StoredSubsessionDelegation,
    ) -> Result<Value, BtccError> {
        let result = self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        Ok(
            json!({"relation_id":relation.relation_id,"request":relation.packet.objective,
            "acceptance_criteria":relation.packet.acceptance_criteria,"result":result}),
        )
    }

    pub(super) async fn followup_context(
        &self,
        request: &StewardDelegationRequest,
    ) -> Result<Option<String>, BtccError> {
        let Some(id) = &request.previous_relation_id else {
            return Ok(None);
        };
        let relation = self
            .repository
            .relation_by_id(id.clone())
            .await
            .map_err(BtccError::from)?
            .filter(|r| {
                r.parent_session_id == request.parent_session_id
                    && r.packet.child_role == crate::btcc::ChildRole::Steward
            })
            .ok_or_else(|| error(BtccCode::StewardRelationNotFound))?;
        let terminal = self
            .repository
            .result_for_relation(id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some();
        if !terminal {
            return Err(BtccError::detected(
                BtccCode::StewardRelationNotActive,
                "The previous child has no terminal outcome yet. Wait for its result or steer its existing owner; do not replace a running assignment.",
            ));
        }
        Ok(Some(self.prior_context(&relation).await?.to_string()))
    }

    /// One indexed current snapshot, not a transcript or parent-history scan.
    pub async fn latest_steward_prompt(&self, parent: String) -> Result<String, BtccError> {
        let Some(relation) = self
            .repository
            .latest_relation_for_parent(parent)
            .await
            .map_err(BtccError::from)?
        else {
            return Ok(String::new());
        };
        if relation.packet.child_role != crate::btcc::ChildRole::Steward {
            return Ok(String::new());
        }
        let result = self
            .repository
            .result_for_relation(relation.relation_id.clone())
            .await
            .map_err(BtccError::from)?;
        let open = self
            .repository
            .open_relation_by_work(relation.root_work_id.clone())
            .await
            .map_err(BtccError::from)?
            .is_some();
        let state = match (result.is_some(), open) {
            (false, _) => "active: steer_steward for related follow-ups",
            (true, true) => "reported, Work open/blocked: steer_steward to its retained owner",
            (true, false) => {
                "closed: new requests need a fresh reviewed Work and delegate_to_steward(previous_relation_id) in this turn"
            }
        };
        Ok(format!(
            "Most recent Steward delegation (model-only):\nrelation_id: {}\nstate: {state}\nprior_request: {}\nprior_result: {}",
            relation.relation_id,
            relation.packet.objective,
            result.map_or_else(|| "pending".into(), |r| r.to_string())
        ))
    }
}
