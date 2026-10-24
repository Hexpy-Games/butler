//! Writer-lane races that require control over in-flight publishers.
use crate::workspace::SessionRole;
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
async fn cb_11_late_publish_failure_cannot_retire_new_continuation() -> Result<(), ServiceError> {
    for permanent in [false, true] {
        for continuation in [false, true] {
            late_failure_cannot_retire_new_continuation(permanent, continuation).await?;
        }
    }
    Ok(())
}

async fn late_failure_cannot_retire_new_continuation(
    permanent: bool,
    continuation: bool,
) -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    f.queue.permanent_failure.store(permanent, Ordering::SeqCst);
    f.create("first", "parent", ChildRole::Worker)?;
    f.queue.hold_dispatch.store(true, Ordering::SeqCst);
    let service = f.service.clone();
    let publishing = tokio::spawn(async move { service.recover_dispatches().await });
    tokio::time::timeout(Duration::from_secs(30), f.queue.reached.notified())
        .await
        .unwrap();
    if continuation {
        f.service
            .complete_child("first", "turn-first", "cancelled", "Cancelled".into())
            .await?;
        f.direction("first")?;
        f.service.admit_waiting_workers().await?;
        assert_eq!(f.count("parent").await?, 1);
    } else {
        f.service
            .cancel(SubsessionCancelRequest {
                parent_session_id: "parent".into(),
                parent_turn_id: "parent-turn".into(),
                source_message_id: "stop".into(),
                relation_id: Some("rel-first".into()),
                safe_title: None,
                child_role: SessionRole::Worker,
            })
            .await?;
    }
    *f.queue.release.0.lock().unwrap() = true;
    f.queue.release.1.notify_all();
    publishing.await??;
    if continuation {
        assert_eq!(f.count("parent").await?, 1);
        assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    } else {
        assert_eq!(f.count("parent").await?, 0);
        assert_eq!(f.state("first"), None);
        assert!(
            f.service
                .repository()
                .result_for_relation("rel-first".into())
                .await?
                .is_none()
        );
    }
    f.close().await
}
