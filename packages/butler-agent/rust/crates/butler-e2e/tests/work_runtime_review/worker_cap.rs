//! Real service races, with a captured queue and a mutable settings port.
use super::*;
use butler_turn::{btcc::*, workspace::*};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};

#[derive(Default)]
struct Queue(Mutex<Vec<String>>, Mutex<Vec<serde_json::Value>>);
impl SubsessionChildQueue for Queue {
    fn enqueue(&self, input: SubsessionEnqueue) -> std::result::Result<(), BtccError> {
        self.1.lock().unwrap().push(input.envelope.clone());
        self.0.lock().unwrap().push(
            input.envelope["routingHints"]["sessionId"]
                .as_str()
                .unwrap()
                .into(),
        );
        Ok(())
    }
    fn interrupted_event(
        &self,
        _: &str,
        _: &str,
        _: &str,
    ) -> std::result::Result<Option<InterruptedSubsessionEvent>, BtccError> {
        Ok(None)
    }
}
struct Profiles(
    AtomicU32,
    AtomicBool,
    tokio::sync::watch::Sender<bool>,
    tokio::sync::Notify,
);
impl WorkerProfileReader for Profiles {
    fn wait_ready(&self) -> PortFuture<'_, ()> {
        Box::pin(async {
            let mut ready = self.2.subscribe();
            self.3.notify_one();
            ready.wait_for(|ready| *ready).await.unwrap();
            Ok(())
        })
    }
    fn max_simultaneous(&self) -> PortFuture<'_, u32> {
        Box::pin(async {
            if self.1.load(Ordering::SeqCst) || !*self.2.borrow() {
                return Err(BtccError::relayed(
                    "settings_unavailable",
                    "Settings unavailable",
                ));
            }
            Ok(self.0.load(Ordering::SeqCst))
        })
    }
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn read(&self, _: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async {
            Ok(WorkerProfile {
                id: "default".into(),
                label: "Builder".into(),
                enabled: true,
                model_ref: "openai/gpt-6-luna".into(),
                reasoning_effort: "low".into(),
                prompt: None,
                job: json!({}),
            })
        })
    }
}
struct Clock;
impl WorkspaceClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        100
    }
    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|v| v.timestamp_millis())
    }
    fn iso_from_epoch_millis(&self, _: i64) -> WorkspaceResult<String> {
        Ok("2026-10-23T00:00:00Z".into())
    }
}
struct Fixture {
    _fixture: TestStorageFixture,
    storage: BtccStorage,
    bindings: SessionBindingStore,
    queue: Arc<Queue>,
    profiles: Arc<Profiles>,
    service: SubsessionService,
}
impl Fixture {
    async fn open() -> std::result::Result<Self, Failure> {
        let fixture = TestStorageFixture::activated();
        let storage = BtccStorage::open(fixture.config("worker-cap")).await?;
        storage.work_model_write(bootstrap).await?;
        let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
            path: fixture.config("binding").path.with_extension("bindings"),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(Clock),
        })
        .await?;
        bindings
            .upsert(UpsertSessionBinding {
                session_id: "parent".into(),
                role: butler_turn::workspace::SessionRole::Butler,
                project_id: None,
                app_project_id: OwnOptional::Absent,
                ledger_project_id: OwnOptional::Absent,
                workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
                runtime_adapter_id: "btcc-turn-runtime".into(),
                model_provider_id: "openai".into(),
                model_ref: "openai/gpt-6-luna".into(),
                runtime_session_ref: None,
                provider_thread_ref: None,
                transport_bindings: vec![SessionTransportBinding {
                    transport: "app".into(),
                    account_id: "local".into(),
                    peer_id: "parent".into(),
                    thread_id: None,
                }],
                lifecycle_state: None,
                created_at: None,
                updated_at: None,
                last_active_at: None,
                metadata: None,
            })
            .await?;
        let queue = Arc::new(Queue::default());
        let profiles = Arc::new(Profiles(
            AtomicU32::new(1),
            AtomicBool::new(false),
            tokio::sync::watch::channel(true).0,
            tokio::sync::Notify::new(),
        ));
        let service = service(&storage, &bindings, queue.clone(), profiles.clone());
        Ok(Self {
            _fixture: fixture,
            storage,
            bindings,
            queue,
            profiles,
            service,
        })
    }
    async fn close(self) -> std::result::Result<(), Failure> {
        self.bindings.close().await?;
        self.storage.close().await?;
        Ok(())
    }
    async fn counts(&self) -> std::result::Result<(i64, i64), Failure> {
        Ok(self.storage.work_model_read(|db| Ok(db.query_row("SELECT sum(i.state='applied' AND a.status='running'),sum(i.state='pending') FROM wm_cross_db_intents i JOIN wm_attempts a ON i.op_id='child_dispatch:'||a.id WHERE i.kind='child_dispatch'",[],|r|Ok((r.get(0)?,r.get(1)?)))?)).await?)
    }
    async fn finish(
        &self,
        output: &serde_json::Value,
        status: &str,
    ) -> std::result::Result<(), Failure> {
        let session = output["child_session_id"].as_str().unwrap();
        let relation = self.service.hook_parent_session_id(session.into()).await?;
        assert_eq!(relation.as_deref(), Some("parent"));
        let session_owned = session.to_owned();
        let turn = self
            .storage
            .work_model_read(move |db| {
                Ok(db.query_row(
                    "SELECT turn_id FROM wm_attempts WHERE session_id=?1",
                    [session_owned],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .await?;
        self.service
            .complete_child(session, &turn, status, "report".into())
            .await?;
        Ok(())
    }
}
fn service(
    storage: &BtccStorage,
    bindings: &SessionBindingStore,
    queue: Arc<Queue>,
    profiles: Arc<Profiles>,
) -> SubsessionService {
    let now: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| "2026-10-23T00:00:00Z".into());
    let work = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(storage.clone(), now.clone()),
    )));
    SubsessionService::new(
        SqliteSubsessionRepository::new(storage.clone()),
        bindings.clone(),
        queue,
        profiles,
        work,
        now,
    )
}
fn bootstrap(tx: &Transaction<'_>) -> store::Result<()> {
    let admission = butler_work::cutover::accept(
        tx,
        &butler_work::cutover::ManagedAdmission {
            message_id: "request".into(),
            session_id: "parent".into(),
            turn_id: "parent-turn".into(),
            body: "Build reports".into(),
            received_seq: 1,
            sender: json!({"user":{"principal_id":"person"}}),
        },
    )?;
    let scope = apply::ApplyScope {
        session_id: "parent".into(),
        turn_id: "parent-turn".into(),
        instruction_id: admission,
        work_id: None,
        tier: 2,
        planning: false,
        floors: Default::default(),
        child_session: false,
    };
    let spec = json!({"node_id":"@s","revision":1,"body_hash":"@s"});
    let detail = json!({"node_id":"@d","revision":1,"body_hash":"@d"});
    let input = serde_json::from_value(
        json!({"reason":"Build reports","spec_ref":spec,"expected_task_graph_revision":0,"operations":[
        {"op":"spec.propose","key":"s","node":{"title":"Reports","goal":"Build reports","criteria":["Checked"],"constraints":[]}},
        {"op":"spec.propose","key":"d","node":{"title":"Detail","goal":"Build reports","criteria":["Verified"],"constraints":[]}},
        {"op":"spec.activate","published_refs":[spec,detail],"expected_tree_version":0},
        {"op":"task.add","key":"t","title":"Reports","description":"Build reports","step":"new","acceptance_refs":[
            {"node_id":"@s","node_revision":1,"criterion_id":"c0"},{"node_id":"@d","node_revision":1,"criterion_id":"c0"}]},
        {"op":"task.start","task_id":"@t"}]}),
    )?;
    apply::apply(tx, &context(), &scope, &input)?;
    Ok(())
}
fn request(objective: &str) -> WorkerDelegationRequest {
    WorkerDelegationRequest {
        parent_session_id: "parent".into(),
        parent_turn_id: "parent-turn".into(),
        anchor_message_id: "request".into(),
        source_tool_call_id: objective.into(),
        action_key: objective.into(),
        part_id: None,
        objective: objective.into(),
        acceptance_criteria: vec!["Checked".into()],
        implementation_brief: "Build and inspect report".into(),
        safe_title: None,
        profile_id: None,
        access_mode: "read_only".into(),
        schedule_run: None,
    }
}

// test-category: race
#[tokio::test]
async fn release_racing_dispatch_never_over_admits_and_keeps_fifo()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let clone = f.service.clone();
    let (first, second) = tokio::join!(
        f.service.delegate_worker(request("First")),
        clone.delegate_worker(request("Second"))
    );
    let first = first?;
    let second = second?;
    assert_eq!(f.counts().await?, (1, 1));
    let (running, waiting) = if first["status"] == "waiting" {
        (&second, &first)
    } else {
        (&first, &second)
    };
    let oldest = waiting["child_session_id"].as_str().unwrap();
    let third = f.service.delegate_worker(request("Third")).await?;
    assert_eq!(third["status"], "waiting");
    let (done, new) = tokio::join!(
        f.finish(running, "success"),
        f.service.delegate_worker(request("Fourth"))
    );
    done?;
    let new = new?;
    assert_eq!(new["status"], "waiting");
    assert_eq!(f.counts().await?, (1, 2));
    assert_eq!(f.queue.0.lock().unwrap().len(), 2);
    assert_eq!(f.queue.0.lock().unwrap()[1], oldest);
    // Retrying an already pending delegation must not bypass the gate.
    assert_eq!(f.service.delegate_worker(request("Third")).await?, third);
    f.finish(waiting, "failed").await?;
    assert_eq!(f.counts().await?, (1, 1));
    assert_eq!(f.queue.0.lock().unwrap()[2], third["child_session_id"]);
    f.close().await
}

// test-category: race
#[tokio::test]
async fn recovery_rebuilds_slots_and_lowered_setting_waits_for_release()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let mut f = Fixture::open().await?;
    let first = f.service.delegate_worker(request("First")).await?;
    let second = f.service.delegate_worker(request("Second")).await?;
    let third = f.service.delegate_worker(request("Third")).await?;
    f.profiles.0.store(2, Ordering::SeqCst);
    f.queue.0.lock().unwrap().clear();
    f.service = service(&f.storage, &f.bindings, f.queue.clone(), f.profiles.clone());
    f.service.recover_native_assignments(vec![]).await?;
    f.service.recover_waiting_workers().await?;
    assert_eq!(f.counts().await?, (2, 1));
    assert_eq!(
        f.queue.0.lock().unwrap().as_slice(),
        [second["child_session_id"].as_str().unwrap()]
    );
    f.profiles.0.store(1, Ordering::SeqCst);
    f.service.recover_native_assignments(vec![]).await?;
    f.service.recover_waiting_workers().await?;
    assert_eq!(f.counts().await?, (2, 1));
    f.finish(&first, "cancelled").await?;
    assert_eq!(f.counts().await?, (1, 1));
    f.finish(&second, "success").await?;
    assert_eq!(f.counts().await?, (1, 0));
    assert_eq!(
        f.queue.0.lock().unwrap().last().unwrap(),
        third["child_session_id"].as_str().unwrap()
    );
    f.close().await
}

// test-category: race
#[tokio::test]
async fn cancelling_waiting_worker_settles_intent_without_dispatch()
-> std::result::Result<(), Failure> {
    butler_e2e::gate!();
    let f = Fixture::open().await?;
    let first = f.service.delegate_worker(request("First")).await?;
    let second = f.service.delegate_worker(request("Second")).await?;
    let third = f.service.delegate_worker(request("Third")).await?;
    let mut stop: SessionControlRequest = serde_json::from_value(json!({
        "target_session_id":second["child_session_id"],"mode":"steer","instruction":{"control":"stop"},
        "expected_control_epoch":0,"idempotency_key":"cancel-waiting"
    }))?;
    stop.parent_session_id = "parent".into();
    let (cancelled, fourth) = tokio::join!(
        f.service.session_control(stop),
        f.service.delegate_worker(request("Fourth"))
    );
    assert_eq!(cancelled?["ok"], true);
    assert_eq!(fourth?["status"], "waiting");
    assert_eq!(f.counts().await?, (1, 2));
    f.finish(&first, "success").await?;
    assert_eq!(f.counts().await?, (1, 1));
    let sessions = f.queue.0.lock().unwrap().clone();
    let second_id = second["attempt_id"].as_str().unwrap().to_owned();
    let state=f.storage.work_model_read(move |db| Ok(db.query_row("SELECT a.status,p.status,i.state FROM wm_attempts a JOIN wm_task_parts p ON p.id=a.part_id JOIN wm_cross_db_intents i ON i.op_id='child_dispatch:'||a.id WHERE a.id=?1",[second_id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?)).await?;
    assert_eq!(
        state,
        ("interrupted".into(), "cancelled".into(), "applied".into())
    );
    assert_eq!(
        sessions,
        vec![
            first["child_session_id"].as_str().unwrap(),
            third["child_session_id"].as_str().unwrap()
        ]
    );
    f.close().await
}

#[path = "worker_cap/review.rs"]
mod review;
