use super::*;

struct PreparationProbe {
    original: Arc<dyn TurnPreparation>,
    drops: Arc<AtomicUsize>,
}

struct ConversationProbe {
    original: Box<dyn PreparedConversation>,
    drops: Arc<AtomicUsize>,
}

impl TurnPreparation for PreparationProbe {
    fn prepare(&self, request: TurnRequest) -> PortFuture<'_, PreparedExecution> {
        Box::pin(async move {
            let mut execution = self.original.prepare(request).await?;
            execution.conversation = Box::new(ConversationProbe {
                original: execution.conversation,
                drops: self.drops.clone(),
            });
            Ok(execution)
        })
    }
}

impl PreparedConversation for ConversationProbe {
    fn record_event<'a>(&'a self, event: &'a RuntimeTurnEventInput) -> PortFuture<'a, ()> {
        self.original.record_event(event)
    }
    fn complete(&self, outcome: TurnOutcome) -> PortFuture<'_, ()> {
        self.original.complete(outcome)
    }
    fn cancel(&self) -> PortFuture<'_, ()> {
        self.original.cancel()
    }
}

impl Drop for ConversationProbe {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

fn assembly(harness: &Arc<Harness>) -> (crate::btcc::BtccAssembly, Arc<AtomicUsize>) {
    let drops = Arc::new(AtomicUsize::new(0));
    let mut dependencies = harness.dependencies();
    dependencies.preparation = Arc::new(PreparationProbe {
        original: dependencies.preparation,
        drops: drops.clone(),
    });
    (crate::btcc::assemble(dependencies), drops)
}

#[tokio::test]
async fn conversation_owner_drops_after_final_suspension_error_and_panic() {
    for mode in [
        "delivered",
        "suspended",
        "progress_error",
        "missing_turn",
        "panic",
    ] {
        let records = if mode == "missing_turn" {
            Vec::new()
        } else {
            vec![record("turn-1", "session-1", TurnSemanticState::Admitted)]
        };
        let harness = Harness::new(records);
        harness
            .suspend_agent
            .store(mode == "suspended", Ordering::SeqCst);
        harness
            .fail_started_progress
            .store(mode == "progress_error", Ordering::SeqCst);
        harness.panic_agent.store(mode == "panic", Ordering::SeqCst);
        let (assembly, drops) = assembly(&harness);
        let outcome = assembly.btcc.run_turn(request("turn-1", "session-1")).await;
        match mode {
            "delivered" => assert!(matches!(
                outcome.unwrap().result,
                TurnOutcomeKind::Delivered(_)
            )),
            "suspended" => assert!(matches!(
                outcome.unwrap().result,
                TurnOutcomeKind::Suspended { .. }
            )),
            _ => assert!(outcome.is_err(), "{mode}"),
        }
        assert_eq!(drops.load(Ordering::SeqCst), 1, "{mode}");
        assembly.host.close().await.unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 1, "{mode}");
    }
}

#[tokio::test]
async fn cancelled_caller_does_not_drop_live_conversation_until_owned_work_drains() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let harness = Harness::new([record("turn-1", "session-1", TurnSemanticState::Admitted)]);
        harness.block_agent.store(true, Ordering::SeqCst);
        let (assembly, drops) = assembly(&harness);
        let caller =
            tokio::spawn(
                async move { assembly.btcc.run_turn(request("turn-1", "session-1")).await },
            );
        while harness.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        harness.permits.add_permits(1);
        assembly.host.close().await.unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    })
    .await
    .expect("owned conversation must drain");
}
