use std::future::pending;

use tokio::sync::oneshot;

use super::*;

fn policy(idle: Option<u64>) -> RequestPolicy {
    RequestPolicy {
        total: Duration::from_secs(10),
        idle: idle.map(Duration::from_secs),
    }
}

#[tokio::test(start_paused = true)]
async fn starts_at_dispatch_resets_idle_and_retained_handle_cannot_rearm() {
    let (tx, rx) = oneshot::channel();
    let request = tokio::spawn(run_guarded(
        CancellationToken::new(),
        policy(Some(2)),
        |progress| async move {
            assert!(tx.send(progress).is_ok());
            pending::<Result<(), ()>>().await
        },
    ));
    let progress = rx.await.unwrap();
    tokio::time::advance(Duration::from_secs(100)).await;
    assert!(!request.is_finished());
    progress.start();
    tokio::time::advance(Duration::from_secs(1)).await;
    progress.record_progress();
    tokio::time::advance(Duration::from_secs(1)).await;
    assert!(!request.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(
        request.await.unwrap(),
        Err(GuardError::Timeout(TimeoutKind::Idle))
    );
    assert!(progress.cancellation().is_cancelled());
    let before = progress.shared.deadlines.lock().progress;
    progress.record_progress();
    assert_eq!(progress.shared.deadlines.lock().progress, before);
    assert!(progress.shared.deadlines.lock().disposed);
}

#[tokio::test(start_paused = true)]
async fn progress_does_not_extend_total_and_disabled_idle_still_has_total() {
    for idle in [None, Some(2)] {
        let result = run_guarded(
            CancellationToken::new(),
            policy(idle),
            |progress| async move {
                progress.start();
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    progress.record_progress();
                }
                Ok::<_, ()>(())
            },
        )
        .await;
        assert_eq!(result, Err(GuardError::Timeout(TimeoutKind::Total)));
    }
}

#[tokio::test(start_paused = true)]
async fn external_abort_wins_caught_operation_error_and_drop_cancels_inline_request() {
    let external = CancellationToken::new();
    let result = run_guarded(external.clone(), policy(None), |_| async {
        external.cancel();
        Err::<(), _>("provider error")
    })
    .await;
    assert_eq!(result, Err(GuardError::Cancelled));

    let (tx, rx) = oneshot::channel();
    let request = tokio::spawn(run_guarded(
        CancellationToken::new(),
        policy(None),
        |progress| async move {
            progress.start();
            assert!(tx.send(progress).is_ok());
            pending::<Result<(), ()>>().await
        },
    ));
    let progress = rx.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert!(progress.cancellation().is_cancelled());
    assert!(progress.shared.deadlines.lock().disposed);
}

#[tokio::test(start_paused = true)]
async fn ordinary_success_and_failure_dispose_deadlines_without_changing_result() {
    for expected in [Ok(7), Err("parse error")] {
        let (tx, rx) = oneshot::channel();
        let result = run_guarded(
            CancellationToken::new(),
            policy(Some(2)),
            |progress| async move {
                progress.record_progress();
                assert!(tx.send(progress).is_ok());
                expected
            },
        )
        .await;
        assert_eq!(result, expected.map_err(GuardError::Operation));
        let progress = rx.await.unwrap();
        assert!(progress.shared.deadlines.lock().disposed);
        let before = progress.shared.deadlines.lock().progress;
        tokio::time::advance(Duration::from_secs(100)).await;
        progress.start();
        progress.record_progress();
        assert_eq!(progress.shared.deadlines.lock().progress, before);
        let owner = Arc::downgrade(&progress.shared);
        drop(progress);
        assert!(owner.upgrade().is_none());
    }
}
