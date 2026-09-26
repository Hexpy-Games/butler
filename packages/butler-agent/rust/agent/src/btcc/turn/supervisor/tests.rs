
use super::*;

#[test]
fn stop_fence_blocks_reentry_until_persistence_outcome_allows_it() {
    let supervisor = TurnExecutionSupervisor::default();
    let permit = supervisor
        .enter("turn-1", TurnSemanticState::Admitted)
        .unwrap();
    drop(permit);
    assert_eq!(
        supervisor.registration_count(),
        0,
        "ordinary permit retires"
    );

    // A stop cancels the running permit; a failed stop keeps the fence.
    let permit = supervisor
        .enter("turn-1", TurnSemanticState::Admitted)
        .unwrap();
    let ticket = supervisor.install_stop("turn-1");
    assert!(permit.cancellation().is_cancelled());
    supervisor.observe_stop_failure(&ticket);
    drop(permit);
    assert!(
        supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .is_err()
    );

    // A turn already finalizing may still deliver, then retires.
    let supervisor = TurnExecutionSupervisor::default();
    let ticket = supervisor.install_stop("turn-1");
    supervisor.observe_stop(&ticket, StopPersistenceOutcome::AlreadyFinalizing);
    assert!(
        supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .is_err()
    );
    let permit = supervisor
        .enter("turn-1", TurnSemanticState::DeliveryCommitted)
        .unwrap();
    supervisor.observe_terminal("turn-1");
    drop(permit);
    assert_eq!(supervisor.registration_count(), 0);
}

#[test]
fn stale_stop_results_cannot_change_newer_registrations_or_fences() {
    let supervisor = TurnExecutionSupervisor::default();
    let ticket = supervisor.install_stop("turn-1");
    supervisor.observe_stop(&ticket, StopPersistenceOutcome::AlreadyCancelled);
    let permit = supervisor
        .enter("turn-1", TurnSemanticState::Admitted)
        .unwrap();
    supervisor.observe_stop_failure(&ticket);
    drop(permit);
    assert_eq!(supervisor.registration_count(), 0);

    let supervisor = TurnExecutionSupervisor::default();
    let older = supervisor.install_stop("turn-1");
    let newer = supervisor.install_stop("turn-1");
    supervisor.observe_stop_failure(&newer);
    supervisor.observe_stop(&older, StopPersistenceOutcome::AlreadyFinalizing);
    assert!(
        supervisor
            .enter("turn-1", TurnSemanticState::DeliveryCommitted)
            .is_err()
    );
}
