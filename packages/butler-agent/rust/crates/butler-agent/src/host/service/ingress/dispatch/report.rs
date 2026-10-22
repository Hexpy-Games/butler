//! W-C advances only after the parent's final action reaches the App.
use super::*;

pub(super) async fn deliver(
    item: &ClaimedInboundEvent,
    envelope: &Envelope,
    binding: &butler_turn::workspace::StoredSessionBinding,
    outcome: &butler_turn::btcc::TurnOutcome,
    delivery: &dyn IngressDelivery,
    subsessions: &butler_turn::btcc::SubsessionService,
) -> Result<Executed, super::super::IngressError> {
    let actions = action::actions(item, &envelope, &binding, &outcome)?;
    let eligible = match &outcome.result {
        TurnOutcomeKind::Delivered(value) if value.runtime_failure.is_none() => {
            Some(value.turn_id.clone())
        }
        _ => None,
    };
    let mut delivered = 0;
    let mut final_delivered = false;
    for action in actions {
        let final_action = action
            .pointer("/metadata/kind")
            .and_then(serde_json::Value::as_str)
            == Some("final_result");
        if !trace::deliver(delivery, &binding.session_id, action).await? {
            return Err(super::super::IngressError::new(
                "inbound_delivery_interrupted",
                "App result delivery unavailable",
            ));
        }
        delivered += 1;
        final_delivered |= final_action;
    }
    if final_delivered
        && eligible.is_some()
        && let Some(relation) = envelope
            .app_turn_context
            .as_ref()
            .and_then(|context| context.pointer("/subsessionResult/relation_id"))
            .and_then(serde_json::Value::as_str)
    {
        subsessions
            .report_delivered(relation)
            .await
            .map_err(|error| {
                super::super::IngressError::new("subsession_report_commit_failed", error.code())
            })?;
    }
    Ok(Executed {
        delivered,
        eligible_turn_id: final_delivered.then_some(eligible).flatten(),
    })
}
