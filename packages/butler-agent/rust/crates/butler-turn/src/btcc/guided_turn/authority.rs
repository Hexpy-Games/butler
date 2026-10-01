use crate::btcc::TurnRecord;
use crate::btcc::authority::contracts::{AuthorityExecutionInput, PrincipalAuthority};

use super::work::GuidedPreparationError;

/// The decision a suspended guided turn resumes with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuidedAuthorityDecision {
    Allow,
    Deny,
    Modify(String),
}

/// The decision for the turn's pending authority request, if it was decided.
pub async fn guided_authority_loop_decision(
    authority: Option<&PrincipalAuthority>,
    turn: &TurnRecord,
    owner_session_id: &str,
) -> Result<Option<GuidedAuthorityDecision>, GuidedPreparationError> {
    let Some(cursor) = turn.authority_continuation.as_ref() else {
        return Ok(None);
    };
    let Some(authority) = authority else {
        return Err(GuidedPreparationError::Contract(
            "authority_context_missing",
        ));
    };
    let request_ref = &cursor.request_ref;
    let call_id = cursor.call_id.as_str();
    let execution = authority
        .execution(AuthorityExecutionInput {
            owner_session_id: owner_session_id.to_owned(),
            request_ref: request_ref.to_owned(),
            source_session_id: Some(turn.session_id.clone()),
            client_message_id: None,
            turn_id: turn.turn_id.clone(),
        })
        .await?;
    if execution.source_call_id.as_deref() != Some(call_id) {
        return Err(GuidedPreparationError::Contract(
            "authority_source_call_mismatch",
        ));
    }
    if execution.capability == "ask_user" {
        return Ok(Some(GuidedAuthorityDecision::Allow));
    }
    Ok(Some(match execution.decision {
        crate::btcc::RequestDecision::Modified => {
            GuidedAuthorityDecision::Modify(execution.alternative_input.ok_or(
                GuidedPreparationError::Contract("authority_request_corrupt"),
            )?)
        }
        crate::btcc::RequestDecision::Allowed => GuidedAuthorityDecision::Allow,
        crate::btcc::RequestDecision::Denied | crate::btcc::RequestDecision::Pending => {
            GuidedAuthorityDecision::Deny
        }
    }))
}
