//! Writer-lane races that require control over in-flight publishers.
use crate::{btcc::*, workspace::*};
use serde_json::json;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
type ServiceError = Box<dyn std::error::Error + Send + Sync>;
mod fixture;
use fixture::Fixture;

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_concurrent_admission_and_completion_never_exceed_cap() -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.service.recover_dispatches().await?;
    f.admit_turn("first", "turn-first").await?;
    for child in ["second", "third"] {
        f.create(child, "parent", ChildRole::Worker)?;
    }
    let barrier = Arc::new(tokio::sync::Barrier::new(9));
    let mut tasks = Vec::new();
    for index in 0..8 {
        let service = f.service.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            if index == 0 {
                service
                    .complete_failed_child("first", "turn-first", "execution_failed")
                    .await?;
            } else {
                service.admit_waiting_workers().await?;
            }
            assert!(
                service
                    .repository()
                    .running_worker_count("parent".into())
                    .await?
                    <= 1
            );
            Ok::<_, ServiceError>(())
        }));
    }
    barrier.wait().await;
    for task in tasks {
        task.await??;
    }
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("second").as_deref(), Some("enqueued"));
    assert_eq!(f.state("third").as_deref(), Some("pending"));
    f.close().await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_late_publish_failure_cannot_retire_a_new_continuation() -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.queue.hold_dispatch.store(true, Ordering::SeqCst);
    let service = f.service.clone();
    let publishing = tokio::spawn(async move { service.recover_dispatches().await });
    tokio::time::timeout(Duration::from_secs(30), f.queue.reached.notified())
        .await
        .unwrap();
    f.service
        .complete_child("first", "turn-first", "cancelled", "Cancelled".into())
        .await?;
    f.direction("first")?;
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.count("parent").await?, 1);
    *f.queue.release.0.lock().unwrap() = true;
    f.queue.release.1.notify_all();
    publishing.await??;
    assert_eq!(f.count("parent").await?, 1);
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    f.close().await
}
