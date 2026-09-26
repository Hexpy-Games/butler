use super::*;
use std::{process::Stdio, time::Duration};
use tokio::process::Command;

#[tokio::test]
async fn active_cancellation_kills_and_reaps_child() {
    let mut child = Command::new("/bin/sleep")
        .arg("30")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("sleep child");
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
        mode: EmbeddingMode::LegacyMean,
        requested_texts: 1,
        resplit: false,
        max_embeddings: None,
        cancellation: cancellation.clone(),
        deadline: None,
        response: sender,
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
    assert_eq!(failure.code, "embed_request_cancelled");
    assert!(process.is_none());
    let status = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid="])
        .status()
        .expect("ps child");
    assert!(!status.success(), "cancelled child must be reaped");
}

#[cfg(unix)]
#[tokio::test]
async fn slow_initialization_outlives_first_deadline_and_keeps_ready_child() {
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg("IFS= read -r line; sleep 0.2; printf '%s\\n' '{\"id\":1,\"status\":\"ready\"}'; sleep 30")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("fake slow worker");
    let mut process = Some(WorkerChild {
        stdin: child.stdin.take().expect("child stdin"),
        stdout: child.stdout.take().expect("child stdout"),
        child,
        initialized: false,
    });
    let inner = Inner {
        data_root: PathBuf::new(),
        executable: PathBuf::new(),
        next_id: AtomicU64::new(1),
        state: Mutex::new(QueueState::default()),
        notify: Notify::new(),
        shutdown: CancellationToken::new(),
    };
    let (sender, _) = oneshot::channel();
    let item = Pending {
        id: 1,
        frame: b"{}\n".to_vec(),
        bytes: 3,
        mode: EmbeddingMode::CheckedCls,
        requested_texts: 1,
        resplit: false,
        max_embeddings: None,
        cancellation: CancellationToken::new(),
        deadline: Some(Instant::now() + Duration::from_millis(50)),
        response: sender,
    };
    let failure = tokio::time::timeout(
        Duration::from_secs(3),
        run_item(&inner, &mut process, &item),
    )
    .await
    .expect("initialization settles")
    .err()
    .expect("first caller expires");
    assert_eq!(failure.code, "embed_request_deadline");
    let ready = process.as_mut().expect("owner keeps initialized child");
    assert!(ready.initialized);
    assert!(ready.child.try_wait().expect("child status").is_none());
    kill_and_reap(&mut process).await;
}

#[tokio::test]
async fn concurrent_and_repeated_close_finish_even_when_actor_fails() {
    let owner = NativeEmbeddingOwner::new(PathBuf::new()).expect("owner without model load");
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

    let failed_owner = NativeEmbeddingOwner::new(PathBuf::new()).expect("owner without model load");
    failed_owner
        .actor
        .lock()
        .expect("embedding actor mutex")
        .as_ref()
        .expect("actor")
        .abort();
    let (first, second) = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::join!(failed_owner.close(), failed_owner.close())
    })
    .await
    .expect("concurrent close after actor abort completes");
    assert_eq!(
        first.expect_err("aborted actor fails").code,
        "embed_worker_unavailable"
    );
    assert_eq!(
        second.expect_err("aborted actor fails").code,
        "embed_worker_unavailable"
    );
}
