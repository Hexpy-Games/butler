//! A plain inbound turn, run on its bound session.

use std::path::Path;

use butler_turn::btcc::{Btcc, SubsessionService, TurnOutcome};
use butler_turn::workspace::{SessionBindingStore, StoredSessionBinding};
use tokio_util::sync::CancellationToken;

use super::super::{
    IngressError,
    bind::{self, Envelope},
};
use super::errors;

/// Runs the turn, or returns `None` for a child turn with nothing left to
/// continue, which settles without a Turn.
pub(super) async fn run(
    envelope: &Envelope,
    (btcc, shutdown): (&Btcc, &CancellationToken),
    bindings: &SessionBindingStore,
    data_root: &Path,
    default_workspace: &Path,
    subsessions: &SubsessionService,
) -> Result<Option<(StoredSessionBinding, TurnOutcome)>, IngressError> {
    if !admissible(envelope, subsessions).await? {
        return Ok(None);
    }
    let request = bind::bind_and_request(envelope, bindings, data_root, default_workspace).await?;
    let session_id = request.session_id.clone();
    let outcome = super::super::shutdown::run(btcc, request, shutdown)
        .await
        .map_err(|error| errors::turn_error(&error))?;
    let binding = bindings
        .get_by_session_id(&session_id)
        .await
        .map_err(|source| {
            IngressError::new("session_binding_unavailable", "Session binding unavailable")
                .with_source(source)
        })?
        .ok_or_else(|| {
            IngressError::new("session_binding_missing", "Session binding unavailable")
        })?;
    Ok(Some((binding, outcome)))
}

async fn admissible(
    envelope: &Envelope,
    subsessions: &SubsessionService,
) -> Result<bool, IngressError> {
    let Some(session) = envelope
        .native_steward_context
        .as_ref()
        .and(envelope.routing_hints.as_ref())
        .and_then(|hints| hints.session_id.as_deref())
    else {
        return Ok(true);
    };
    subsessions
        .child_turn_admissible(session, bind::routed_turn_id(envelope))
        .await
        .map_err(|error| IngressError::new("subsession_admission_unavailable", error.code()))
}
