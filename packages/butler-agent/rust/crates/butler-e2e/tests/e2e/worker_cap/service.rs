//! Durable service interleavings with controlled queue and settings boundaries.
use super::*;
type ServiceError = Box<dyn std::error::Error + Send + Sync>;
use butler_turn::{btcc::*, workspace::*};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

struct Clock;
impl WorkspaceClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        butler_core::js_date::parse_iso_millis(value)
    }
    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        Ok(butler_core::js_date::format_iso_millis(value).unwrap())
    }
}
#[derive(Default)]
struct Queue {
    inputs: Mutex<Vec<SubsessionEnqueue>>,
    hold: AtomicBool,
    fail_dispatch: AtomicBool,
    reached: tokio::sync::Notify,
    release: (Mutex<bool>, std::sync::Condvar),
}
impl SubsessionChildQueue for Queue {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError> {
        let result = input.envelope["eventId"]
            .as_str()
            .unwrap_or("")
            .starts_with("worker-result:");
        if !result && self.fail_dispatch.swap(false, Ordering::SeqCst) {
            return Err(BtccError::relayed("queue_unavailable", "Queue unavailable"));
        }
        self.inputs.lock().unwrap().push(input);
        if result && self.hold.swap(false, Ordering::SeqCst) {
            self.reached.notify_one();
            let (lock, cv) = &self.release;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cv.wait(released).unwrap();
            }
        }
        Ok(())
    }
    fn interrupted_event(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError> {
        Ok(None)
    }
}
struct Profiles {
    cap: AtomicU64,
    fail: AtomicBool,
}
impl WorkerProfileReader for Profiles {
    fn max_simultaneous_workers(&self) -> PortFuture<'_, u64> {
        Box::pin(async {
            if self.fail.load(Ordering::SeqCst) {
                Err(BtccError::relayed(
                    "settings_unavailable",
                    "Settings unavailable",
                ))
            } else {
                Ok(self.cap.load(Ordering::SeqCst))
            }
        })
    }
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn read(&self, _: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async { Err(BtccError::relayed("no_profile", "No profile")) })
    }
}
struct Fixture {
    _fixture: TestStorageFixture,
    storage: BtccStorage,
    bindings: SessionBindingStore,
    service: SubsessionService,
    queue: Arc<Queue>,
    profiles: Arc<Profiles>,
    db: std::path::PathBuf,
}
impl Fixture {
    async fn open() -> Result<Self, ServiceError> {
        let fixture = TestStorageFixture::activated();
        let config = fixture.config("cap-service");
        let db = config.path.clone();
        let storage = BtccStorage::open(config).await?;
        let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
            path: db.with_file_name("sessions.sqlite"),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(Clock),
        })
        .await?;
        let queue = Arc::new(Queue::default());
        let profiles = Arc::new(Profiles {
            cap: AtomicU64::new(1),
            fail: AtomicBool::new(false),
        });
        let now: Arc<dyn Fn() -> String + Send + Sync> =
            Arc::new(|| "2026-10-24T00:00:00.000Z".into());
        let service = SubsessionService::new(
            SqliteSubsessionRepository::new(storage.clone()),
            bindings.clone(),
            queue.clone(),
            profiles.clone(),
            Arc::new(DurableWorkService::new(Arc::new(
                SessionWorkRepository::new(storage.clone(), now.clone()),
            ))),
            now,
        );
        let f = Self {
            _fixture: fixture,
            storage,
            bindings,
            service,
            queue,
            profiles,
            db,
        };
        f.binding("parent", butler_turn::workspace::SessionRole::Steward)
            .await?;
        f.create("parent", "chat", ChildRole::Steward).await?;
        // Its original dispatch is already admitted, so recovery must only replay Workers.
        rusqlite::Connection::open(&f.db)?.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id='rel-parent'", [])?;
        Ok(f)
    }
    async fn binding(
        &self,
        session: &str,
        role: butler_turn::workspace::SessionRole,
    ) -> Result<(), ServiceError> {
        self.bindings
            .upsert(UpsertSessionBinding {
                session_id: session.into(),
                role,
                project_id: None,
                app_project_id: OwnOptional::Absent,
                ledger_project_id: OwnOptional::Absent,
                workspace_path: "/tmp".into(),
                runtime_adapter_id: "btcc-turn-runtime".into(),
                model_provider_id: "provider".into(),
                model_ref: "provider/model".into(),
                runtime_session_ref: None,
                provider_thread_ref: None,
                transport_bindings: vec![],
                lifecycle_state: None,
                created_at: None,
                updated_at: None,
                last_active_at: None,
                metadata: Some(
                    json!({"reasoning_effort":"medium","runtimePolicy":{"trackingMode":"local"}})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            })
            .await?;
        Ok(())
    }
    async fn create(&self, child: &str, parent: &str, role: ChildRole) -> Result<(), ServiceError> {
        let mut packet = SubsessionPacket::fixture(role, "Verify evidence");
        packet.parent_session_id = parent.into();
        let mut intent = DispatchIntent::fixture();
        intent.envelope.event_id = format!("dispatch-{child}");
        intent.envelope.routing_hints.session_id = child.into();
        intent.envelope.routing_hints.turn_id = format!("turn-{child}");
        let mut db = rusqlite::Connection::open(&self.db)?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES (?1,?2,'parent-turn',?3,'anchor',(SELECT COALESCE(MAX(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?2),'Verify evidence','2026-10-24T00:00:00.000Z')", rusqlite::params![format!("rel-{child}"), parent, child])?;
        tx.execute("INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,root_work_id,child_turn_id,packet_json,dispatch_intent_json,dispatch_state,created_at,parent_session_id,child_role) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending','2026-10-24T00:00:00.000Z',?8,?9)", rusqlite::params![format!("del-{child}"),format!("rel-{child}"),format!("task-{child}"),format!("root-{child}"),format!("turn-{child}"),serde_json::to_string(&packet)?,serde_json::to_string(&intent)?,parent,role.as_str()])?;
        tx.commit()?;
        Ok(())
    }
    async fn direction(&self, child: &str) -> Result<(), ServiceError> {
        // Place the durable direction at the delivery boundary, after result commit.
        rusqlite::Connection::open(&self.db)?.execute("INSERT INTO btcc_subsession_directions (instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) VALUES ('direction',?1,1,'parent-turn','source','Verify updated evidence','pending','2026-10-24T00:00:01.000Z')", [format!("rel-{child}")])?;
        Ok(())
    }
    fn state(&self, child: &str) -> Option<String> {
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .query_row(
                "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
                [format!("rel-{child}")],
                |r| r.get(0),
            )
            .unwrap()
    }
    async fn close(self) -> Result<(), ServiceError> {
        self.bindings.close().await?;
        self.storage.close().await?;
        Ok(())
    }
}

#[tokio::test]
async fn cb_11_cancel_waiting_writes_result_and_never_starts() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker).await?;
    }
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    let output = f
        .service
        .cancel(SubsessionCancelRequest {
            parent_session_id: "parent".into(),
            parent_turn_id: "parent-turn".into(),
            source_message_id: "cancel".into(),
            relation_id: Some("rel-waiting".into()),
            safe_title: None,
            child_role: butler_turn::workspace::SessionRole::Worker,
        })
        .await?;
    assert_eq!(output["status"], "cancelling");
    // Queue consumer handles this control before the first execution exists.
    f.service
        .complete_child("waiting", "turn-waiting", "cancelled", "Cancelled".into())
        .await?;
    let result: String = rusqlite::Connection::open(&f.db)?.query_row(
        "SELECT status FROM btcc_steward_results WHERE relation_id='rel-waiting'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(result, "cancelled");
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    f.service.recover_dispatches().await?;
    assert_eq!(f.state("waiting"), None);
    assert!(
        !f.queue
            .inputs
            .lock()
            .unwrap()
            .iter()
            .any(|i| i.envelope["eventId"] == "dispatch-waiting")
    );
    f.close().await
}

#[tokio::test]
async fn cb_11_failed_settings_read_uses_last_cap_and_delivers() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "second", "third"] {
        f.create(child, "parent", ChildRole::Worker).await?;
    }
    f.service.recover_dispatches().await?;
    f.profiles.fail.store(true, Ordering::SeqCst);
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    assert_eq!(f.state("second").as_deref(), Some("enqueued"));
    assert_eq!(f.state("third").as_deref(), Some("pending"));
    assert!(f.queue.inputs.lock().unwrap().iter().any(|i| {
        i.envelope["eventId"]
            .as_str()
            .unwrap_or("")
            .starts_with("worker-result:")
    }));
    f.close().await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_direction_between_result_commit_and_delivery_keeps_slot() -> Result<(), ServiceError>
{
    butler_e2e::gate!();
    direction_delivery_race(false).await
}

// test-category: race
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cb_11_applied_continuation_retains_slot_until_completion() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    direction_delivery_race(true).await
}

async fn direction_delivery_race(applied: bool) -> Result<(), ServiceError> {
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker).await?;
    }
    f.service.recover_dispatches().await?;
    f.queue.hold.store(true, Ordering::SeqCst);
    let service = f.service.clone();
    let completing = tokio::spawn(async move {
        service
            .complete_failed_child("first", "turn-first", "execution_failed")
            .await
    });
    tokio::time::timeout(Duration::from_secs(30), f.queue.reached.notified())
        .await
        .unwrap();
    // The result transaction committed, but delivery has not yet cleared the slot.
    f.direction("first").await?;
    f.service.recover_dispatches().await?;
    let turn = f
        .queue
        .inputs
        .lock()
        .unwrap()
        .iter()
        .find_map(|input| {
            (input.envelope["raw"]["source"] == "btcc-subsession-direction").then(|| {
                input.envelope["routingHints"]["turnId"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
        })
        .unwrap();
    if applied {
        let mut prepared = test_prepared_turn();
        prepared.request.turn_id = turn.clone();
        prepared.request.session_id = "first".into();
        prepared.request.event_id = turn.clone();
        prepared.request.message.id = turn.clone();
        prepared.command = TurnCommand::fixture_run(
            &turn,
            "first",
            &turn,
            CommandMessage {
                message_id: turn.clone(),
                content: "Verify updated evidence".into(),
            },
            json!({}),
        );
        prepared.preparation_id = turn.clone();
        BtccRepositories::new(f.storage.clone(), None)
            .load_or_admit(&prepared)
            .await?;
        assert!(f.service.consume_direction("first", &turn).await?.is_some());
    }
    *f.queue.release.0.lock().unwrap() = true;
    f.queue.release.1.notify_all();
    completing.await.unwrap()?;
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("first", &turn, "execution_failed")
        .await?;
    assert_eq!(f.state("first"), None);
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}

#[tokio::test]
async fn cb_11_failed_first_settings_read_uses_default_ten() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for index in 0..11 {
        f.create(&format!("worker-{index}"), "parent", ChildRole::Worker)
            .await?;
    }
    f.profiles.fail.store(true, Ordering::SeqCst);
    f.service.recover_dispatches().await?;
    let running = (0..11)
        .filter(|i| f.state(&format!("worker-{i}")).as_deref() == Some("enqueued"))
        .count();
    assert_eq!(running, 10);
    assert_eq!(f.state("worker-10").as_deref(), Some("pending"));
    f.close().await
}

#[tokio::test]
async fn cb_11_admission_replays_after_queue_write_failure() -> Result<(), ServiceError> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    for child in ["first", "waiting"] {
        f.create(child, "parent", ChildRole::Worker).await?;
    }
    f.queue.fail_dispatch.store(true, Ordering::SeqCst);
    assert!(f.service.recover_dispatches().await.is_err());
    assert_eq!(f.state("first").as_deref(), Some("enqueued"));
    f.service.recover_dispatches().await?;
    assert!(
        f.queue
            .inputs
            .lock()
            .unwrap()
            .iter()
            .any(|i| i.envelope["eventId"] == "dispatch-first")
    );
    assert_eq!(f.state("waiting").as_deref(), Some("pending"));
    f.service
        .complete_failed_child("first", "turn-first", "execution_failed")
        .await?;
    assert_eq!(f.state("waiting").as_deref(), Some("enqueued"));
    f.close().await
}
