use super::*;
use butler_turn::btcc::TestStorageFixture;

pub(super) fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .expect("fixture timestamp")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
struct Clock;
impl WorkspaceClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        1_790_812_800_000
    }
    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|v| v.timestamp_millis())
    }
    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        Ok(iso(value))
    }
}
#[derive(Default)]
pub(super) struct Queue(pub(super) Mutex<Vec<SubsessionEnqueue>>);
impl SubsessionChildQueue for Queue {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError> {
        self.0.lock().expect("queue").push(input);
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
struct Profiles;
impl WorkerProfileReader for Profiles {
    fn list(&self) -> PortFuture<'_, Vec<WorkerProfile>> {
        Box::pin(async { Ok(vec![profile()]) })
    }
    fn read(&self, _: Option<String>) -> PortFuture<'_, WorkerProfile> {
        Box::pin(async { Ok(profile()) })
    }
}
fn profile() -> WorkerProfile {
    WorkerProfile {
        id: "builder".into(),
        label: "Builder".into(),
        enabled: true,
        model_ref: "openai/gpt-6-luna".into(),
        reasoning_effort: "low".into(),
        prompt: None,
        job: json!({}),
    }
}

impl GraphBuilder {
    pub async fn open(data: &Path) -> Result<Self, Error> {
        let fixture = TestStorageFixture::activated();
        let mut config = fixture.config("graph-builder");
        let path = data.join("agent-runtime/btcc.sqlite");
        std::fs::create_dir_all(path.parent().ok_or("missing parent")?)?;
        if !path.exists() {
            std::fs::copy(&config.path, &path)?;
        }
        config.path = path;
        config.activation.manifest_id = rusqlite::Connection::open(&config.path)?.query_row(
            "SELECT manifest_id FROM agent_storage_activation_marker WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        let storage = BtccStorage::open(config).await?;
        let turns = BtccRepositories::new(storage.clone(), None);
        let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
            path: session_store_path(data),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(Clock),
        })
        .await?;
        let latest: Option<String> = rusqlite::Connection::open(data.join("agent-runtime/btcc.sqlite"))?.query_row(
            "SELECT MAX(at) FROM (SELECT MAX(updated_at) at FROM btcc_guided_works UNION ALL SELECT MAX(created_at) FROM btcc_steward_results)", [], |r| r.get(0))?;
        let millis = latest
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map_or(chrono::Utc::now().timestamp_millis() - 3_000, |v| {
                v.timestamp_millis()
                    .max(chrono::Utc::now().timestamp_millis() - 3_000)
            });
        let clock = Arc::new(Mutex::new(millis));
        let time = clock.clone();
        let now: Arc<dyn Fn() -> String + Send + Sync> =
            Arc::new(move || iso(*time.lock().expect("clock")));
        let work = Arc::new(DurableWorkService::new(Arc::new(
            SessionWorkRepository::new(storage.clone(), now.clone()),
        )));
        let queue = Arc::new(Queue::default());
        let children = SubsessionService::new(
            SqliteSubsessionRepository::new(storage.clone()),
            bindings.clone(),
            queue.clone(),
            Arc::new(Profiles),
            work.clone(),
            now,
        );
        Ok(Self {
            storage,
            turns,
            bindings,
            work,
            children,
            queue,
            clock,
            sequence: 0,
        })
    }

    pub(super) async fn admit(
        &mut self,
        session: &str,
        turn: &str,
        role: SessionRole,
    ) -> Result<(), Error> {
        let mut prepared = test_prepared_turn();
        prepared.request.turn_id = turn.into();
        prepared.request.session_id = session.into();
        prepared.request.event_id = turn.into();
        prepared.request.message.id = turn.into();
        prepared.request.route.role = role;
        prepared.command = TurnCommand::fixture_run(
            turn,
            session,
            turn,
            CommandMessage {
                message_id: turn.into(),
                content: "Prepare the release".into(),
            },
            json!({}),
        );
        prepared.preparation_id = turn.into();
        self.turns.load_or_admit(&prepared).await?;
        Ok(())
    }

    pub(super) async fn admit_child(
        &mut self,
        session: &str,
        role: SessionRole,
    ) -> Result<Attempt, Error> {
        let inputs = std::mem::take(&mut *self.queue.0.lock().expect("queue"));
        let envelope = inputs
            .iter()
            .find(|input| {
                input
                    .envelope
                    .pointer("/routingHints/sessionId")
                    .and_then(Value::as_str)
                    == Some(session)
            })
            .or_else(|| inputs.last())
            .ok_or("missing child dispatch")?;
        let turn = envelope
            .envelope
            .pointer("/routingHints/turnId")
            .and_then(Value::as_str)
            .ok_or("missing child turn")?
            .to_owned();
        self.admit(session, &turn, role).await?;
        self.children.ensure_child_work(session, &turn).await?;
        Ok(Attempt {
            task: String::new(),
            session: session.into(),
            turn,
        })
    }
}
