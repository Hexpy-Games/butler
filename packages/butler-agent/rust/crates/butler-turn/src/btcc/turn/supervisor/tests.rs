use super::*;

// test-category: race
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
    assert_eq!(
        supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .err()
            .unwrap()
            .code(),
        BtccCode::TurnCancelled.as_str()
    );
    supervisor.observe_stop_failure(&ticket);
    drop(permit);
    assert_eq!(
        supervisor
            .enter("turn-1", TurnSemanticState::Admitted)
            .err()
            .unwrap()
            .code(),
        BtccCode::TurnCancelled.as_str()
    );

    // A turn already finalizing may still deliver, then retires.
    let supervisor = TurnExecutionSupervisor::default();
    let ticket = supervisor.install_stop("turn-1");
    supervisor.observe_stop(&ticket, &StopPersistenceOutcome::AlreadyFinalizing);
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

    let supervisor = TurnExecutionSupervisor::default();
    let permit = supervisor
        .enter("duplicate", TurnSemanticState::Admitted)
        .unwrap();
    let error = supervisor
        .enter("duplicate", TurnSemanticState::Admitted)
        .err()
        .unwrap();
    assert_eq!(error.code(), BtccCode::TurnFenced.as_str());
    assert!(!permit.cancellation().is_cancelled());
    drop(permit);
    assert!(
        supervisor
            .enter("duplicate", TurnSemanticState::Admitted)
            .is_ok()
    );
}
