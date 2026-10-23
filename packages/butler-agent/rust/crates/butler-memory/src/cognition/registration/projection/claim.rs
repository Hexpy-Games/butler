//! Validate source authority and claim or retire due work under one write lease.

use super::{
    ActiveProjectionWindowOwners, Operation, ProjectionDependencies, assert_current, notice,
    pending,
};
use crate::cognition::{
    CognitionResult, GraphProgress,
    graph::{ClaimProjectionWindowInput, ClaimedProjectionWindow, source_validity},
};
use std::sync::Arc;

pub(super) enum Next {
    Window(Arc<ClaimedProjectionWindow>),
    Settled(Box<GraphProgress>),
    Empty,
}

pub(super) async fn next(
    operation: &Operation,
    owners: &ActiveProjectionWindowOwners,
    deps: &ProjectionDependencies,
) -> CognitionResult<Next> {
    let host = deps.host.clone();
    let active = owners.lock().clone();
    let claim_owners = owners.clone();
    let nonce = host.new_uuid();
    let now = (operation.clock)();
    operation
        .write(move |state| {
            let current = pending::resolve(state)
                .and_then(|()| notice::refresh_source_hash(state, &now))
                .and_then(|()| assert_current(state, &now));
            match current {
                Err(error) if source_validity::is_invalid(error.code()) => {
                    return state
                        .graph
                        .settle_invalid_source(&state.input.job_id, error.code(), &now)
                        .map(|progress| Next::Settled(Box::new(progress)));
                }
                Err(error) if error.code() == "memory_write_busy" => {
                    return state
                        .graph
                        .defer_unavailable_source(&state.input.job_id, &now)
                        .map(|progress| Next::Settled(Box::new(progress)));
                }
                result => result?,
            }
            let claim = state
                .graph
                .claim_projection_window(ClaimProjectionWindowInput {
                    job_id: Some(&state.input.job_id),
                    now: &now,
                    owner_pid: host.process_id(),
                    owner_nonce: &nonce,
                    active_owners: &active,
                    process_status: &|pid| host.process_status(pid),
                })?;
            if let Some(claim) = &claim {
                claim_owners.lock().insert((
                    claim.job_id.clone(),
                    claim.window_ref.clone(),
                    claim.owner_nonce.clone(),
                ));
            }
            Ok(claim.map_or(Next::Empty, |claim| Next::Window(Arc::new(claim))))
        })
        .await
}
