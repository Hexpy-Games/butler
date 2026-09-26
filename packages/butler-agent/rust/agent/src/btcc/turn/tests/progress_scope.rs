use super::*;

struct EventTrace {
    order: Mutex<Vec<(&'static str, String)>>,
    writes: Mutex<Vec<ProgressWrite>>,
    entered: Semaphore,
    release: Semaphore,
    recovery: AtomicUsize,
}

struct RecordingPreparation {
    original: Arc<dyn TurnPreparation>,
    trace: Arc<EventTrace>,
}

impl TurnPreparation for RecordingPreparation {
    fn prepare(&self, request: TurnRequest) -> PortFuture<'_, PreparedExecution> {
        Box::pin(async move {
            let mut execution = self.original.prepare(request).await?;
            assert_eq!(execution.turn.preparation_id, "turn-1");
            execution.conversation = Box::new(RecordingConversation {
                original: execution.conversation,
                trace: self.trace.clone(),
            });
            Ok(execution)
        })
    }
}

struct RecordingConversation {
    original: Box<dyn PreparedConversation>,
    trace: Arc<EventTrace>,
}

impl PreparedConversation for RecordingConversation {
    fn record_event<'a>(&'a self, event: &'a RuntimeTurnEventInput) -> PortFuture<'a, ()> {
        Box::pin(async move {
            if event.kind == "tool.started" {
                self.trace.entered.add_permits(1);
                self.trace.release.acquire().await.unwrap().forget();
            }
            self.original.record_event(event).await?;
            self.trace
                .order
                .lock()
                .unwrap()
                .push(("conversation", event.kind.clone()));
            Ok(())
        })
    }
    fn complete(&self, outcome: TurnOutcome) -> PortFuture<'_, ()> {
        self.original.complete(outcome)
    }
    fn cancel(&self) -> PortFuture<'_, ()> {
        self.original.cancel()
    }
}

impl AgentLoop for EventTrace {
    fn run<'a>(
        &'a self,
        _: &'a TurnRecord,
        _: &'a StateExecutionClaim,
        recovery_attempt: u32,
        progress: &'a dyn AgentLoopProgress,
        _: &'a dyn crate::btcc::ModelRoundObserver,
        _: tokio_util::sync::CancellationToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<AgentLoopResult, AgentLoopError>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.recovery
                .store(recovery_attempt as usize, Ordering::SeqCst);
            let mut event = RuntimeTurnEventInput::new("tool.started");
            event.id = Some("event-fixture".into());
            event.payload = json!({"toolCallId":"tool-1"}).as_object().cloned();
            progress
                .emit(event)
                .await
                .map_err(AgentLoopError::Propagate)?;
            Ok(agent_result())
        })
    }
}

impl ProgressEventRepository for EventTrace {
    fn append(&self, write: ProgressWrite) -> PortFuture<'_, ()> {
        Box::pin(async move {
            self.order
                .lock()
                .unwrap()
                .push(("durable", write.event.kind.clone()));
            self.writes.lock().unwrap().push(write);
            Ok(())
        })
    }

    fn first_destination(&self, _: &str) -> PortFuture<'_, Option<ProgressDestination>> {
        Box::pin(async { Ok(None) })
    }
}

#[tokio::test]
async fn scoped_loop_progress_awaits_conversation_and_keeps_reclaimed_destination() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut input = request("turn-1", "session-1");
        input.recovery_attempt = Some(3);
        input.app_queue_claim_id = Some("reclaimed-new".into());
        let mut admitted = record("turn-1", "session-1", TurnSemanticState::Admitted);
        admitted.progress_destination = Some(ProgressDestination {
            transport: "app".into(),
            account_id: "account".into(),
            peer: input.peer.clone(),
            reply_to_message_id: input.message.id.clone(),
            app_queue_claim_id: Some("previous-claim".into()),
        });
        let harness = Harness::new([admitted]);
        let trace = Arc::new(EventTrace {
            order: Mutex::new(Vec::new()),
            writes: Mutex::new(Vec::new()),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            recovery: AtomicUsize::new(0),
        });
        let mut dependencies = harness.dependencies();
        dependencies.preparation = Arc::new(RecordingPreparation {
            original: dependencies.preparation.clone(),
            trace: trace.clone(),
        });
        dependencies.agent = trace.clone();
        dependencies.progress = trace.clone();
        let assembly = crate::btcc::assemble(dependencies);
        let host = assembly.host;
        let running = tokio::spawn(async move { assembly.btcc.run_turn(input).await });
        trace.entered.acquire().await.unwrap().forget();
        assert!(
            !trace
                .writes
                .lock()
                .unwrap()
                .iter()
                .any(|write| write.event.kind == "tool.started")
        );
        trace.release.add_permits(1);
        assert!(matches!(
            running.await.unwrap().unwrap().result,
            TurnOutcomeKind::Delivered(_)
        ));
        host.close().await.unwrap();
        assert_eq!(trace.recovery.load(Ordering::SeqCst), 3);
        let writes = trace.writes.lock().unwrap();
        let write = writes
            .iter()
            .find(|write| write.event.kind == "tool.started")
            .unwrap();
        assert_eq!(
            write.destination.app_queue_claim_id.as_deref(),
            Some("reclaimed-new")
        );
        assert_eq!(write.session_id, "session-1");
        assert_eq!(write.turn_id, "turn-1");
        assert_eq!(write.event.id.as_deref(), Some("event-fixture"));
        assert_eq!(
            write.event.payload.as_ref().unwrap()["toolCallId"],
            "tool-1"
        );
        let order = trace.order.lock().unwrap();
        let position = |phase| {
            order
                .iter()
                .position(|entry| entry.0 == phase && entry.1 == "tool.started")
                .unwrap()
        };
        assert!(position("conversation") < position("durable"));
    })
    .await
    .expect("scoped progress must complete");
}
