use crate::btcc::TurnRecord;
use crate::btcc::authority::contracts::{AuthorityExecutionInput, NativePrincipalAuthority};

use super::work::GuidedPreparationError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum GuidedAuthorityDecision {
    Allow,
    Deny,
    Modify(String),
}

pub(crate) async fn guided_authority_loop_decision(
    authority: Option<&NativePrincipalAuthority>,
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
    let request_ref = cursor
        .get("requestRef")
        .and_then(|value| value.as_str())
        .ok_or(GuidedPreparationError::Contract(
            "invalid_authority_continuation",
        ))?;
    let call_id = cursor
        .get("callId")
        .and_then(|value| value.as_str())
        .ok_or(GuidedPreparationError::Contract(
            "invalid_authority_continuation",
        ))?;
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
    Ok(Some(match execution.decision.as_str() {
        "modified" => GuidedAuthorityDecision::Modify(execution.alternative_input.ok_or(
            GuidedPreparationError::Contract("authority_request_corrupt"),
        )?),
        "allowed" => GuidedAuthorityDecision::Allow,
        _ => GuidedAuthorityDecision::Deny,
    }))
}
