//! Run a dispatch or authenticated control before its result is delivered.
use super::*;
use butler_turn::{btcc::TurnOutcome, workspace::StoredSessionBinding};
type Result<T> = std::result::Result<T, super::super::IngressError>;

pub(super) async fn execute(
    envelope: &Envelope,
    turn: (&Btcc, &tokio_util::sync::CancellationToken),
    bindings: &SessionBindingStore,
    data_root: &Path,
    workspace: &Path,
) -> Result<(StoredSessionBinding, TurnOutcome)> {
    let (btcc, shutdown) = turn;
    let kind = envelope
        .control
        .as_ref()
        .and_then(|control| control.get("kind"))
        .and_then(serde_json::Value::as_str);
    match kind {
        None => plain(envelope, turn, bindings, data_root, workspace).await,
        Some("cancel_turn") => cancel(envelope, btcc, bindings).await,
        Some("resume_turn") => {
            let binding = bind::existing_control_binding(envelope, bindings).await?;
            let request = bind::control_request(envelope, &binding)?;
            let outcome = super::super::shutdown::run(btcc, request, shutdown)
                .await
                .map_err(|error| turn_error(&error))?;
            Ok((binding, outcome))
        }
        Some(_) => Err(super::super::IngressError::new(
            "inbound_control_unsupported",
            "Unknown inbound control",
        )),
    }
}

async fn plain(
    envelope: &Envelope,
    turn: (&Btcc, &tokio_util::sync::CancellationToken),
    bindings: &SessionBindingStore,
    data_root: &Path,
    workspace: &Path,
) -> Result<(StoredSessionBinding, TurnOutcome)> {
    let request = bind::bind_and_request(envelope, bindings, data_root, workspace).await?;
    let session = request.session_id.clone();
    let outcome = super::super::shutdown::run(turn.0, request, turn.1)
        .await
        .map_err(|error| turn_error(&error))?;
    let binding = bindings
        .get_by_session_id(&session)
        .await
        .map_err(|source| {
            super::super::IngressError::new(
                "session_binding_unavailable",
                "Session binding unavailable",
            )
            .with_source(source)
        })?
        .ok_or_else(|| {
            super::super::IngressError::new(
                "session_binding_missing",
                "Session binding unavailable",
            )
        })?;
    Ok((binding, outcome))
}

async fn cancel(
    envelope: &Envelope,
    btcc: &Btcc,
    bindings: &SessionBindingStore,
) -> Result<(StoredSessionBinding, TurnOutcome)> {
    let binding = bind::existing_control_binding(envelope, bindings).await?;
    let turn = bind::routed_turn_id(envelope);
    if envelope
        .control
        .as_ref()
        .and_then(|value| value.get("turnId"))
        .and_then(serde_json::Value::as_str)
        != Some(turn)
    {
        return Err(super::super::IngressError::new(
            "inbound_control_invalid",
            "Cancellation identity mismatch",
        ));
    }
    let outcome = btcc
        .stop_turn(StopRequest {
            turn_id: turn.into(),
        })
        .await
        .map_err(|error| turn_error(&error))?;
    Ok((binding, outcome))
}
