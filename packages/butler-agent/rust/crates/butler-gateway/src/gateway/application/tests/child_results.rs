//! Exercise the claim-release race with an acknowledged dispatcher drain.
use super::super::*;
use super::support::*;
use crate::gateway::GatewayApplication;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

struct ObservedNative {
    native: Arc<Native>,
    enqueued: Arc<Notify>,
}
impl AppNativeIngress for ObservedNative {
    fn enqueue(&self, turn: AppTurn) -> ApplicationFuture<EnqueueReceipt> {
        let result = self.native.enqueue(turn);
        self.enqueued.notify_one();
        result
    }
    fn find(&self, turn: AppTurn) -> ApplicationFuture<Option<EnqueueReceipt>> {
        self.native.find(turn)
    }
    fn enqueue_cancel(&self, cancel: AppCancellation) -> ApplicationFuture<EnqueueReceipt> {
        self.native.enqueue_cancel(cancel)
    }
    fn stop_confirmed(&self, turn: String) -> ApplicationFuture<bool> {
        self.native.stop_confirmed(turn)
    }
}

struct WaitingChildren;
impl AppSubsessionPort for WaitingChildren {
    fn queue_waits_for_child(&self, _: String) -> ApplicationFuture<bool> {
        Box::pin(async { Ok(true) })
    }
    fn projection(
        &self,
        session: String,
        page: Option<AppSessionViewPage>,
    ) -> ApplicationFuture<serde_json::Value> {
        UnprovidedSessions.projection(session, page)
    }
    fn cancel(&self, parent: String, relation: String) -> ApplicationFuture<serde_json::Value> {
        UnprovidedSessions.cancel(parent, relation)
    }
    fn resume(&self, parent: String, relation: String) -> ApplicationFuture<serde_json::Value> {
        UnprovidedSessions.resume(parent, relation)
    }
    fn read_operation_output_chunks(
        &self,
        turn: String,
        request: String,
        result: String,
    ) -> ApplicationFuture<Vec<operation_output::OperationOutputChunk>> {
        UnprovidedSessions.read_operation_output_chunks(turn, request, result)
    }
}

pub(super) async fn child_result_queued_under_parent_claim_runs_on_suspension_without_other_wake() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let enqueued = Arc::new(Notify::new());
    let mut deps = dependencies(native.clone(), 1200);
    deps.subsessions = Arc::new(WaitingChildren);
    deps.native_ingress = Arc::new(ObservedNative {
        native: native.clone(),
        enqueued: enqueued.clone(),
    });
    let root = std::env::temp_dir().join(format!("butler-child-race-{}", uuid::Uuid::new_v4()));
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            folder_selection_secret: None,
        },
        deps,
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    app.send_message(command("parent", "Delegate work"))
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), enqueued.notified())
        .await
        .unwrap();
    let parent = native.0.lock().unwrap()[0].clone();
    assert!(
        app.send_message(command("followup", "A queued follow-up"))
            .await
            .unwrap()
            .queued
            .is_some()
    );
    let mut result = command("result", "Child output");
    result.request.subsession_result = Some(butler_turn::btcc::SubsessionResultContext {
        relation_id: "relation".into(),
        result_id: "result".into(),
        safe_title: "Child".into(),
    });
    assert!(app.send_message(result).await.unwrap().queued.is_some());
    // Consume every earlier wake while the parent's claim still owns the queue.
    app.queue_wake.drain_chat("general".into()).await.unwrap();
    assert_eq!(native.0.lock().unwrap().len(), 1);
    let turn = &parent.turn_id;
    let claim = parent.app_queue_claim_id.clone();
    let outbound = json!({
        "eventId":"suspended", "sessionId":"butler/app-general", "kind":"outbound",
        "timestamp":"2026-09-14T00:00:01.000Z", "transport":"app",
        "payload":{"actionId":"suspend", "message":{}, "metadata":{
            "kind":"turn_suspended", "turnId":turn, "appQueueClaimId":claim,
            "suspension":"waiting_for_worker"
        }}
    });
    let delivery = json!({
        "eventId":"suspended-delivery", "sessionId":"butler/app-general", "kind":"delivery",
        "timestamp":"2026-09-14T00:00:02.000Z", "transport":"app",
        "payload":{"actionId":"suspend", "ok":true}
    });
    std::fs::create_dir_all(root.join("transcripts")).unwrap();
    std::fs::write(
        root.join("transcripts/butler_app-general.jsonl"),
        format!("{outbound}\n{delivery}\n"),
    )
    .unwrap();
    app.refresh_message_projection("general".into())
        .await
        .unwrap();
    // No drain, send, timer advance or unrelated wake after releasing the claim.
    tokio::time::timeout(std::time::Duration::from_secs(3), enqueued.notified())
        .await
        .unwrap();
    let turns = native.0.lock().unwrap().clone();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1].text, "Child output");
    app.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

struct ReadinessGate(tokio::sync::watch::Receiver<bool>);
impl AppExecutorReadiness for ReadinessGate {
    fn wait_ready(&self) -> ApplicationFuture<()> {
        let mut ready = self.0.clone();
        Box::pin(async move {
            ready
                .wait_for(|ready| *ready)
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            Ok(())
        })
    }
    fn readiness(&self) -> Result<crate::gateway::RuntimeReadinessView, GatewayApplicationError> {
        let mut view = Ready.readiness()?;
        view.btcc_executor_ready = *self.0.borrow();
        Ok(view)
    }
}

pub(super) async fn recovered_child_result_waits_for_executor_readiness_before_claiming() {
    let native = Arc::new(Native(Mutex::new(Vec::new())));
    let enqueued = Arc::new(Notify::new());
    let (release, ready) = tokio::sync::watch::channel(false);
    let mut deps = dependencies(native.clone(), 1500);
    deps.executor_readiness = Arc::new(ReadinessGate(ready));
    deps.native_ingress = Arc::new(ObservedNative {
        native: native.clone(),
        enqueued: enqueued.clone(),
    });
    let root =
        std::env::temp_dir().join(format!("butler-child-readiness-{}", uuid::Uuid::new_v4()));
    let app = AppApplication::open(
        AppApplicationConfig {
            database_path: root.join("app.sqlite"),
            butler_data: root.clone(),
            folder_selection_secret: None,
        },
        deps,
    )
    .await
    .unwrap();
    app.start_dispatch().await.unwrap();
    let mut result = command("result", "Recovered output");
    result.request.subsession_result = Some(butler_turn::btcc::SubsessionResultContext {
        relation_id: "relation".into(),
        result_id: "result".into(),
        safe_title: "Child".into(),
    });
    let sent = app.send_message(result).await.unwrap();
    assert!(sent.queued.is_some());
    assert!(sent.turn.is_none());
    assert!(native.0.lock().unwrap().is_empty());
    release.send(true).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), enqueued.notified())
        .await
        .unwrap();
    assert_eq!(native.0.lock().unwrap()[0].text, "Recovered output");
    app.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
