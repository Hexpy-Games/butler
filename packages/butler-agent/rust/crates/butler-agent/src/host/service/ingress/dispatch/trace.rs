//! Restore the durable producer context on the claimed queue task.
use super::{ClaimedInboundEvent, DispatchDependencies, IngressPoll, one_traced};

pub(in crate::host::service::ingress) async fn one(
    item: ClaimedInboundEvent,
    deps: DispatchDependencies,
) -> IngressPoll {
    use tracing::Instrument;
    let mut context: butler_log::TraceContext = item
        .record
        .metadata
        .get("traceContext")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    // A child or resumed queue item owns its routed identity, while retaining the producer trace.
    if let Ok(envelope) = super::Envelope::from_record(&item.record) {
        context.turn_id = Some(super::bind::routed_turn_id(&envelope).into());
        context.chat_id = Some(envelope.peer.id);
    }
    one_traced(item, deps)
        .instrument(context.root_span("turn.receive"))
        .await
}

pub(super) async fn deliver(
    delivery: &dyn super::super::IngressDelivery,
    session_id: &str,
    action: serde_json::Value,
) -> Result<bool, super::super::IngressError> {
    use tracing::Instrument;
    let final_action = action
        .pointer("/metadata/kind")
        .and_then(serde_json::Value::as_str)
        == Some("final_result");
    delivery
        .deliver(session_id.into(), action)
        .instrument(tracing::info_span!("turn.deliver", final_action))
        .await
}
