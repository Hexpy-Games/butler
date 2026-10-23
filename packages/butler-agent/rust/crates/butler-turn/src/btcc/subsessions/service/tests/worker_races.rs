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
async fn cb_11_publish_failures_preserve_retry_and_continuation_safety() -> Result<(), ServiceError>
{
    publish_retry_and_cancel_acknowledgment().await?;
    permanent_binding_failure_advances_fifo().await?;
    steward_without_dispatch_intent_stays_pending().await?;
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

async fn publish_retry_and_cancel_acknowledgment() -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    f.create("first", "parent", ChildRole::Worker)?;
    f.queue.fail_dispatch.store(true, Ordering::SeqCst);
    let error = f.service.admit_waiting("parent").await.unwrap_err();
    assert_eq!(error.code(), "worker_start_failed");
    assert_eq!(
        error.message(),
        "The Worker could not be started, and nothing is running for it yet. Call delegate_to_worker again with the same request; retrying is safe and will not start it twice."
    );
    assert_eq!(f.state("first").as_deref(), Some("pending"));
    assert_eq!(f.count("parent").await?, 0);
    assert!(f.queue.inputs.lock().unwrap().is_empty());
    // A change in a separate parent remains independent of this pending retry.
    f.binding("other", SessionRole::Steward).await?;
    f.create("peer", "other", ChildRole::Worker)?;
    f.service.admit_waiting("other").await?;
    assert_eq!(f.count("other").await?, 1);
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    assert_eq!(f.count("parent").await?, 1);
    f.create("second", "parent", ChildRole::Worker)?;
    f.queue.fail_dispatch.store(true, Ordering::SeqCst);
    let response = f
        .service
        .cancel(SubsessionCancelRequest {
            parent_session_id: "parent".into(),
            parent_turn_id: "parent-turn".into(),
            source_message_id: "stop".into(),
            relation_id: Some("rel-first".into()),
            safe_title: None,
            child_role: SessionRole::Worker,
        })
        .await?;
    assert_eq!(response["status"], "cancelling");
    assert_eq!(f.state("second").as_deref(), Some("pending"));
    assert_eq!(f.count("parent").await?, 0);
    f.service.admit_waiting_workers().await?;
    assert_eq!(f.state("second").as_deref(), Some("enqueued"));
    {
        let inputs = f.queue.inputs.lock().unwrap();
        for child in ["first", "second", "peer"] {
            assert_eq!(
                inputs
                    .iter()
                    .filter(|i| i.envelope["eventId"] == format!("dispatch-{child}"))
                    .count(),
                1
            );
        }
        assert_eq!(
            inputs
                .iter()
                .filter(|i| i.envelope["control"]["kind"] == "cancel_turn")
                .count(),
            1
        );
    }
    f.close().await
}

async fn permanent_binding_failure_advances_fifo() -> Result<(), ServiceError> {
    for recovery in [false, true] {
        let f = Fixture::open().await?;
        f.create("broken", "parent", ChildRole::Worker)?;
        f.create("next", "parent", ChildRole::Worker)?;
        f.binding("broken", SessionRole::Butler).await?;
        if recovery {
            f.service.recover_dispatches().await?;
        } else {
            f.service.admit_waiting_workers().await?;
        }
        assert_eq!(f.state("broken"), None);
        assert_eq!(f.state("next").as_deref(), Some("enqueued"));
        assert_eq!(f.count("parent").await?, 1);
        let result = f
            .service
            .repository()
            .result_for_relation("rel-broken".into())
            .await?
            .unwrap();
        assert_eq!(result["status"], "failed");
        assert!(
            result["summary"]
                .as_str()
                .unwrap()
                .contains("subsession_child_binding_mismatch")
        );
        let code: String = rusqlite::Connection::open(&f.db)?.query_row(
            "SELECT code FROM btcc_steward_results WHERE relation_id='rel-broken'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(code, "delegation_context_incomplete");
        let stored = f
            .service
            .repository()
            .by_child("broken".into())
            .await?
            .unwrap();
        let output = f.service.worker_output(&stored).await?;
        assert_eq!(output["ok"], false);
        assert_eq!(output["error"]["code"], "delegation_already_finished");
        assert!(output["status"].is_null());
        f.close().await?;
    }
    Ok(())
}

async fn steward_without_dispatch_intent_stays_pending() -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    f.create("steward", "chat", ChildRole::Steward)?;
    rusqlite::Connection::open(&f.db)?.execute("UPDATE btcc_subsession_delegations SET dispatch_intent_json=NULL WHERE relation_id='rel-steward'", [])?;
    let pending = f.service.repository().pending_dispatches().await?;
    assert!(pending.iter().any(|s| s.child_session_id == "steward"));
    assert_eq!(f.state("steward").as_deref(), Some("pending"));
    assert!(
        f.service
            .repository()
            .result_for_relation("rel-steward".into())
            .await?
            .is_none()
    );
    f.close().await
}
