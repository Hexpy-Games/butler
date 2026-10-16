use super::*;
use std::{process::Stdio, time::Duration};

#[tokio::test]
async fn active_cancellation_kills_and_reaps_child() {
    let mut child = butler_platform::process_control::test_support::slow_line_peer(
        r#"{"id":1,"status":"ready"}"#,
    )
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .expect("protocol peer");
    let pid = child.id().expect("child pid");
    let mut process = Some(WorkerChild {
        stdin: child.stdin.take().expect("child stdin"),
        stdout: child.stdout.take().expect("child stdout"),
        child,
        initialized: true,
    });
    let inner = Inner {
        data_root: PathBuf::new(),
        executable: PathBuf::new(),
        next_id: AtomicU64::new(1),
        warm: AtomicBool::new(false),
        enabled: AtomicBool::new(true),
        release: AtomicBool::new(false),
        release_signal: Notify::new(),
        released: watch::channel(false).0,
        state: Mutex::new(QueueState::default()),
        notify: Notify::new(),
        shutdown: CancellationToken::new(),
    };
    let cancellation = CancellationToken::new();
    let (sender, _) = oneshot::channel();
    let item = Pending {
        id: 1,
        frame: b"{}\n".to_vec(),
        bytes: 3,
        cold_start_allowed: true,
        background: false,
        mode: EmbeddingMode::LegacyMean,
        requested_texts: 1,
        resplit: false,
        max_embeddings: None,
        cancellation: cancellation.clone(),
        deadline: None,
        response: PendingResponse::Embedding(sender),
    };
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancellation.cancel();
    });
    let failure = tokio::time::timeout(
        Duration::from_secs(3),
        run_item(&inner, &mut process, &item),
    )
    .await
    .expect("cancel and reap bounded")
    .err()
    .expect("active request cancelled");
    assert_eq!(failure.code(), "embed_request_cancelled");
    assert!(process.is_none());
    assert!(
        butler_platform::instance::process_start(pid)
            .unwrap()
            .is_none(),
        "cancelled child must be reaped"
    );
}

/// Readiness contract: deadline cancellation and concurrent callers share the
/// owner's load; switching off releases it. These exercise the queue API as well
/// as the initialization path previously covered directly through run_item.
// test-category: race
#[tokio::test]
async fn readiness_lifecycle_keeps_one_load_until_release() {
    readiness_tests::prewarm_survives_unobserved_worker_exit().await;
    readiness_tests::readiness_timeout_leaves_load_for_later_waiter().await;
    readiness_tests::concurrent_readiness_waiters_share_one_load().await;
    readiness_tests::switching_off_interrupts_readiness_and_reaps_loading_worker().await;
}

/// Race: concurrent and repeated closes of the embedding owner finish even
/// when its actor fails.
// test-category: race
#[tokio::test]
async fn concurrent_and_repeated_close_finish_even_when_actor_fails() {
    let owner = EmbeddingOwner::new(PathBuf::new()).expect("owner without model load");
    for request_class in [
        EmbeddingRequestClass::WarmInteractive,
        EmbeddingRequestClass::WarmBackground,
    ] {
        let failure = owner
            .embed(
                EmbeddingRequest {
                    texts: vec!["opportunistic".into()],
                    mode: EmbeddingMode::CheckedCls,
                    resplit: true,
                    max_embeddings: Some(1),
                    request_class,
                    deadline_at_epoch_ms: None,
                },
                CancellationToken::new(),
            )
            .await
            .err()
            .expect("warm-only work must never load a child");
        assert_eq!(failure.code(), "embed_worker_cold");
        assert!(!owner.is_warm());
    }
    let (first, second) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(owner.close(), owner.close())
    })
    .await
    .expect("concurrent close completes");
    first.expect("first close");
    second.expect("second close");
    tokio::time::timeout(Duration::from_secs(2), owner.close())
        .await
        .expect("repeated close completes")
        .expect("repeated close succeeds");

    let failed_owner = EmbeddingOwner::new(PathBuf::new()).expect("owner without model load");
    failed_owner.actor.lock().as_ref().expect("actor").abort();
    let (first, second) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(failed_owner.close(), failed_owner.close())
    })
    .await
    .expect("concurrent close after actor abort completes");
    assert_eq!(
        first.expect_err("aborted actor fails").code(),
        "embed_worker_unavailable"
    );
    assert_eq!(
        second.expect_err("aborted actor fails").code(),
        "embed_worker_unavailable"
    );
    readiness_tests::worker_loop_panic_closes_queue_and_future_readiness_fails_fast().await;
}
