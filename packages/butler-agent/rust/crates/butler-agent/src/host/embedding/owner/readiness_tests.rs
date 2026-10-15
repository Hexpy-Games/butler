//! Cases extending the owner's readiness and shutdown lifecycle contracts.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "lifecycle contract assertions"
)]

use super::*;
use std::process::Stdio;

fn inner() -> Arc<Inner> {
    Arc::new(Inner {
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
    })
}

fn owner(
    inner: Arc<Inner>,
    work: impl std::future::Future<Output = ()> + Send + 'static,
) -> EmbeddingOwner {
    let (sender, completion) = watch::channel(None);
    let actor = tokio::spawn(supervision::supervise(inner.clone(), sender, work));
    EmbeddingOwner {
        inner,
        actor: Mutex::new(Some(actor)),
        completion,
    }
}

fn loading_owner() -> EmbeddingOwner {
    let inner = inner();
    let actor_inner = inner.clone();
    owner(inner, async move {
        // Exactly one initialize response: a second load/exchange cannot succeed.
        let mut child = butler_platform::process_control::test_support::slow_line_peer(
            r#"{"id":1,"status":"ready"}"#,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("local protocol peer");
        let mut process = Some(WorkerChild {
            stdin: child.stdin.take().expect("piped stdin"),
            stdout: child.stdout.take().expect("piped stdout"),
            child,
            initialized: false,
        });
        run_loop(&actor_inner, &mut process).await;
        assert!(process.is_none(), "close/off must reap the worker");
    })
}

fn deadline(ms: i64) -> i64 {
    chrono::Utc::now().timestamp_millis() + ms
}

async fn admitted(owner: &EmbeddingOwner, count: usize) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while owner.inner.state.lock().queued_requests < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("waiters admitted within two seconds");
}

pub(super) async fn readiness_timeout_leaves_load_for_later_waiter() {
    let owner = loading_owner();
    assert_eq!(
        owner.ready(deadline(50)).await.unwrap_err().code(),
        "embed_request_deadline"
    );
    assert!(!owner.is_warm(), "caller expired mid-load");
    assert!(
        owner.inner.state.lock().active_cancel.is_some(),
        "owner still loading"
    );
    owner.ready(deadline(2_000)).await.unwrap();
    assert!(owner.is_warm());
    let next = owner.inner.next_id.load(Ordering::Relaxed);
    owner.ready(deadline(50)).await.unwrap();
    assert_eq!(
        owner.inner.next_id.load(Ordering::Relaxed),
        next,
        "warm model reused"
    );
    owner.close().await.unwrap();
}

pub(super) async fn concurrent_readiness_waiters_share_one_load() {
    let owner = loading_owner();
    let (a, b, c, d) = tokio::join!(
        owner.ready(deadline(2_000)),
        owner.ready(deadline(2_000)),
        owner.ready(deadline(2_000)),
        owner.ready(deadline(2_000))
    );
    for result in [a, b, c, d] {
        result.unwrap();
    }
    assert!(owner.is_warm());
    assert_eq!(owner.inner.state.lock().queued_requests, 0);
    owner.close().await.unwrap();
}

pub(super) async fn switching_off_interrupts_readiness_and_reaps_loading_worker() {
    let owner = loading_owner();
    let (result, ()) = tokio::join!(owner.ready(deadline(2_000)), async {
        tokio::time::timeout(Duration::from_secs(2), async {
            while owner.inner.state.lock().active_cancel.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        owner.disable().await;
    });
    assert_eq!(result.unwrap_err().code(), "embed_request_cancelled");
    assert!(!owner.enabled());
    assert!(!owner.is_warm());
    assert!(*owner.inner.released.borrow());
    assert_eq!(
        owner.ready(deadline(2_000)).await.unwrap_err().code(),
        "embed_worker_cold"
    );
    owner.close().await.unwrap();
}

pub(super) async fn worker_loop_panic_closes_queue_and_future_readiness_fails_fast() {
    let inner = inner();
    let crash = Arc::new(Notify::new());
    let trigger = crash.clone();
    let actor_inner = inner.clone();
    let owner = owner(inner, async move {
        trigger.notified().await;
        actor_inner.warm.store(true, Ordering::Release);
        panic!("worker loop failure");
    });
    let started = Instant::now();
    let (a, b, ()) = tokio::join!(
        owner.ready(deadline(4_250)),
        owner.ready(deadline(4_250)),
        async {
            admitted(&owner, 2).await;
            crash.notify_one();
        }
    );
    for result in [a, b] {
        assert_eq!(result.unwrap_err().code(), "embed_owner_closed");
    }
    assert_eq!(
        owner.ready(deadline(4_250)).await.unwrap_err().code(),
        "embed_owner_closed"
    );
    assert!(started.elapsed() < Duration::from_millis(100));
    assert!(!owner.is_warm());
    assert_eq!(
        owner.close().await.unwrap_err().code(),
        "embed_worker_unavailable"
    );
}
