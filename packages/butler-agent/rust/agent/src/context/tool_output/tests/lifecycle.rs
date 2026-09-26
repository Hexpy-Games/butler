use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct BlockingIdentity {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    next_id: AtomicUsize,
}
impl ToolOutputIdentity for BlockingIdentity {
    fn now(&self) -> SystemTime {
        FixedIdentity.now()
    }
    fn uuid(&self) -> String {
        format!("{:012}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }
    fn before_artifact_write(&self) {
        let _ = self.entered.send(());
        self.release.lock().unwrap().recv().unwrap();
    }
}

#[tokio::test]
async fn dropped_caller_and_close_keep_actual_pending_write_owned() {
    let fixture = Fixture::new();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let service = NativeToolOutput::new(
        fixture.root.clone(),
        Arc::clone(&fixture.owner),
        Arc::new(BlockingIdentity {
            entered: entered_tx,
            release: std::sync::Mutex::new(release_rx),
            next_id: AtomicUsize::new(0),
        }),
        Arc::new(TestPruneMetrics(fixture.root.clone())),
    );
    let receiver = service
        .submit_budget(fixture.budget("owned write", true))
        .await
        .unwrap();
    drop(receiver);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if entered_rx.try_recv().is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let day = std::fs::read_dir(fixture.root.join("artifacts/tool-output"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read_dir(&day).unwrap().count(), 0);
    let close = service.close();
    tokio::pin!(close);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut close)
            .await
            .is_err()
    );
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), close)
        .await
        .unwrap();
    assert_eq!(std::fs::read_dir(day).unwrap().count(), 1);
    service.close().await;
    fixture.service.close().await;
}

#[tokio::test]
async fn bounded_queue_drops_waiting_caller_and_close_rejects_pending_submission() {
    let fixture = Fixture::new();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let service = NativeToolOutput::new(
        fixture.root.clone(),
        Arc::clone(&fixture.owner),
        Arc::new(BlockingIdentity {
            entered: entered_tx,
            release: std::sync::Mutex::new(release_rx),
            next_id: AtomicUsize::new(0),
        }),
        Arc::new(TestPruneMetrics(fixture.root.clone())),
    );
    let running = service
        .submit_budget(fixture.budget("running", true))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if entered_rx.try_recv().is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let queued = service
        .submit_budget(fixture.budget("queued", true))
        .await
        .unwrap();
    assert_eq!(service.slots.available_permits(), 0);
    let mut dropped = Box::pin(service.submit_budget(fixture.budget("dropped", true)));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut dropped)
            .await
            .is_err()
    );
    drop(dropped);
    let pending = service.submit_budget(fixture.budget("rejected", true));
    tokio::pin!(pending);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut pending)
            .await
            .is_err()
    );
    let close = service.close();
    tokio::pin!(close);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut close)
            .await
            .is_err()
    );
    let error = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "tool_output_closed");
    release_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if entered_rx.try_recv().is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    release_tx.send(()).unwrap();
    running.await.unwrap().unwrap();
    queued.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(3), close)
        .await
        .unwrap();
    let mut outputs = Vec::new();
    for day in std::fs::read_dir(fixture.root.join("artifacts/tool-output")).unwrap() {
        for artifact in std::fs::read_dir(day.unwrap().path()).unwrap() {
            let body: serde_json::Value =
                serde_json::from_slice(&std::fs::read(artifact.unwrap().path()).unwrap()).unwrap();
            outputs.push(body["result"]["stdout"].as_str().unwrap().to_owned());
        }
    }
    outputs.sort();
    assert_eq!(outputs, ["queued", "running"]);
    fixture.service.close().await;
}
