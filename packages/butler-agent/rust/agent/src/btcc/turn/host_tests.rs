use std::sync::atomic::Ordering;

use super::TurnSemanticState;
use super::test_support::{record, request};
use super::tests::Harness;
use crate::btcc::StopRequest;

#[tokio::test]
async fn close_drains_caller_aborted_stop_and_panicking_stop_without_retention() {
    let harness = Harness::new([record("turn-1", "session-1", TurnSemanticState::Admitted)]);
    harness.block_stop.store(true, Ordering::SeqCst);
    let assembly = crate::btcc::assemble(harness.dependencies());
    let btcc = assembly.btcc.clone();
    let stopped = tokio::spawn(async move {
        btcc.stop_turn(StopRequest {
            turn_id: "turn-1".into(),
        })
        .await
    });
    let duplicate_btcc = assembly.btcc.clone();
    let duplicate_stop = tokio::spawn(async move {
        duplicate_btcc
            .stop_turn(StopRequest {
                turn_id: "turn-1".into(),
            })
            .await
    });
    crate::testing::eventually("both stops persisting", || {
        harness.stop_calls.load(Ordering::SeqCst) == 2
    })
    .await;
    assert_eq!(assembly.btcc.inner.active_stop_count(), 2);
    stopped.abort();
    let host = assembly.host.clone();
    let closing = tokio::spawn(async move { host.close().await });
    tokio::task::yield_now().await;
    assert_eq!(harness.closes.load(Ordering::SeqCst), 0);
    harness.stop_permits.add_permits(1);
    tokio::task::yield_now().await;
    assert_eq!(harness.closes.load(Ordering::SeqCst), 0);
    harness.stop_permits.add_permits(1);
    duplicate_stop.await.unwrap().unwrap();
    closing.await.unwrap().unwrap();
    assert_eq!(assembly.btcc.inner.active_stop_count(), 0);
    assert_eq!(harness.closes.load(Ordering::SeqCst), 1);

    let panic_harness = Harness::new([record("turn-2", "session-2", TurnSemanticState::Admitted)]);
    panic_harness.block_stop.store(true, Ordering::SeqCst);
    panic_harness.panic_stop.store(true, Ordering::SeqCst);
    let panic_assembly = crate::btcc::assemble(panic_harness.dependencies());
    let panic_btcc = panic_assembly.btcc.clone();
    let panicking = tokio::spawn(async move {
        panic_btcc
            .stop_turn(StopRequest {
                turn_id: "turn-2".into(),
            })
            .await
    });
    crate::testing::eventually("panicking stop started", || {
        panic_harness.stop_started.load(Ordering::SeqCst)
    })
    .await;
    panic_harness.stop_permits.add_permits(1);
    assert_eq!(
        panicking.await.unwrap().unwrap_err().code,
        "btcc_task_failed"
    );
    panic_assembly.host.close().await.unwrap();
    assert_eq!(panic_assembly.btcc.inner.active_stop_count(), 0);
    assert_eq!(panic_harness.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn panicking_owned_turn_settles_duplicates_and_close_without_retention() {
    let harness = Harness::new([record("turn-1", "session-1", TurnSemanticState::Admitted)]);
    harness.block_agent.store(true, Ordering::SeqCst);
    harness.panic_agent.store(true, Ordering::SeqCst);
    let assembly = crate::btcc::assemble(harness.dependencies());
    let first_btcc = assembly.btcc.clone();
    let duplicate_btcc = assembly.btcc.clone();
    let first =
        tokio::spawn(async move { first_btcc.run_turn(request("turn-1", "session-1")).await });
    crate::testing::eventually("agent loop entry", || {
        harness.calls.load(Ordering::SeqCst) > 0
    })
    .await;
    let duplicate = tokio::spawn(async move {
        duplicate_btcc
            .run_turn(request("turn-1", "session-1"))
            .await
    });
    tokio::task::yield_now().await;
    let host = assembly.host.clone();
    let closing = tokio::spawn(async move { host.close().await });
    harness.permits.add_permits(1);

    for result in [first.await.unwrap(), duplicate.await.unwrap()] {
        assert_eq!(result.unwrap_err().code, "btcc_task_failed");
    }
    closing.await.unwrap().unwrap();
    assert_eq!(assembly.btcc.inner.active_count(), 0);
    assert_eq!(assembly.btcc.inner.session_tail_count(), 0);
    assert_eq!(harness.closes.load(Ordering::SeqCst), 1);
}
