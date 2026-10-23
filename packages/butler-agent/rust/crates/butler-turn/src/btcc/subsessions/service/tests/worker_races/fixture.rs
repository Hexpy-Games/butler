//! Controlled settings and queue boundaries for durable Worker scenarios.
use super::*;
#[derive(Default)]
pub(super) struct Queue {
    pub(super) inputs: Mutex<Vec<SubsessionEnqueue>>,
    pub(super) hold_dispatch: AtomicBool,
    pub(super) reached: tokio::sync::Notify,
    pub(super) release: (Mutex<bool>, std::sync::Condvar),
}
impl SubsessionChildQueue for Queue {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError> {
        if self.hold_dispatch.swap(false, Ordering::SeqCst) {
            self.reached.notify_one();
            let (lock, cv) = &self.release;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cv.wait(released).unwrap();
            }
            return Err(BtccError::relayed("queue_unavailable", "Queue unavailable"));
        }
        self.inputs.lock().unwrap().push(input);
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
pub(super) struct Profiles {
    pub(super) cap: AtomicU64,
}
impl WorkerProfileReader for Profiles {
    fn max_simultaneous_workers(&self) -> PortFuture<'_, u64> {
        Box::pin(async { Ok(self.cap.load(Ordering::SeqCst)) })
    }
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn read(&self, _: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async { Err(BtccError::relayed("no_profile", "No profile")) })
    }
}
pub(super) struct Fixture {
    _fixture: TestStorageFixture,
    pub(super) storage: BtccStorage,
    pub(super) bindings: SessionBindingStore,
    pub(super) service: SubsessionService,
    pub(super) queue: Arc<Queue>,

    pub(super) db: std::path::PathBuf,
}
impl Fixture {
    pub(super) async fn open() -> Result<Self, ServiceError> {
        let fixture = TestStorageFixture::activated();
        let config = fixture.config("cap-service");
        let db = config.path.clone();
        let storage = BtccStorage::open(config).await?;
        let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
            path: db.with_file_name("sessions.sqlite"),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(crate::test_clock::SystemClock),
        })
        .await?;
        let queue = Arc::new(Queue::default());
        let profiles = Arc::new(Profiles {
            cap: AtomicU64::new(1),
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

            db,
        };
        f.binding("parent", crate::workspace::SessionRole::Steward)
            .await?;
        f.create("parent", "chat", ChildRole::Steward)?;
        // Its original dispatch is already admitted, so recovery must only replay Workers.
        rusqlite::Connection::open(&f.db)?.execute("UPDATE btcc_subsession_delegations SET dispatch_state='enqueued' WHERE relation_id='rel-parent'", [])?;
        Ok(f)
    }
    pub(super) async fn binding(
        &self,
        session: &str,
        role: crate::workspace::SessionRole,
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
    pub(super) fn create(
        &self,
        child: &str,
        parent: &str,
        role: ChildRole,
    ) -> Result<(), ServiceError> {
        let mut packet = SubsessionPacket::fixture(role, "Verify evidence");
        packet.parent_session_id = parent.into();
        let mut intent = DispatchIntent::fixture();
        intent.envelope.event_id = format!("dispatch-{child}");
        intent.envelope.routing_hints.session_id = child.into();
        intent.envelope.routing_hints.turn_id = format!("turn-{child}");
        let mutation = format!("subsession-root-work:del-{child}:task-{child}:{child}");
        let root = format!(
            "guided-work-{}",
            digest_identity(&format!("btcc-guided-work.v1\0work\0{mutation}"))
        );
        let mut db = rusqlite::Connection::open(&self.db)?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES (?1,?2,'parent-turn',?3,'anchor',(SELECT COALESCE(MAX(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?2),'Verify evidence','2026-10-24T00:00:00.000Z')", rusqlite::params![format!("rel-{child}"), parent, child])?;
        tx.execute("INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,root_work_id,child_turn_id,packet_json,dispatch_intent_json,dispatch_state,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending','2026-10-24T00:00:00.000Z')", rusqlite::params![format!("del-{child}"),format!("rel-{child}"),format!("task-{child}"),root,format!("turn-{child}"),serde_json::to_string(&packet)?,serde_json::to_string(&intent)?])?;
        tx.commit()?;
        Ok(())
    }
    pub(super) fn direction(&self, child: &str) -> Result<(), ServiceError> {
        // Place the durable direction at the delivery boundary, after result commit.
        rusqlite::Connection::open(&self.db)?.execute("INSERT INTO btcc_subsession_directions (instruction_id,relation_id,revision,source_parent_turn_id,source_message_id,instruction,status,created_at) VALUES ('direction',?1,1,'parent-turn','source','Verify updated evidence','pending','2026-10-24T00:00:01.000Z')", [format!("rel-{child}")])?;
        rusqlite::Connection::open(&self.db)?.execute("UPDATE btcc_subsession_delegations SET dispatch_state='pending' WHERE relation_id=?1 AND dispatch_state IS NULL", [format!("rel-{child}")])?;
        Ok(())
    }
    pub(super) async fn admit_turn(&self, child: &str, turn: &str) -> Result<(), ServiceError> {
        let mut prepared = test_prepared_turn();
        prepared.request.turn_id = turn.into();
        prepared.request.session_id = child.into();
        prepared.request.event_id = turn.into();
        prepared.request.message.id = turn.into();
        prepared.command = TurnCommand::fixture_run(
            turn,
            child,
            turn,
            CommandMessage {
                message_id: turn.into(),
                content: "Verify updated evidence".into(),
            },
            json!({}),
        );
        prepared.preparation_id = turn.into();
        BtccRepositories::new(self.storage.clone(), None)
            .load_or_admit(&prepared)
            .await?;
        Ok(())
    }
    pub(super) async fn count(&self, parent: &str) -> Result<u64, ServiceError> {
        Ok(self
            .service
            .repository()
            .running_worker_count(parent.into())
            .await?)
    }
    pub(super) fn state(&self, child: &str) -> Option<String> {
        rusqlite::Connection::open(&self.db)
            .unwrap()
            .query_row(
                "SELECT dispatch_state FROM btcc_subsession_delegations WHERE relation_id=?1",
                [format!("rel-{child}")],
                |r| r.get(0),
            )
            .unwrap()
    }
    pub(super) async fn close(self) -> Result<(), ServiceError> {
        self.bindings.close().await?;
        self.storage.close().await?;
        Ok(())
    }
}
