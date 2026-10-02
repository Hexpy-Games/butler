use super::*;
#[tokio::test]
async fn summary_failure_persists_retrieval_fallback() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("context-native-error"))
        .await
        .unwrap();
    let repositories = Arc::new(BtccRepositories::new(storage.clone(), None));
    let mut turn = butler_turn::btcc::agent_loop::test_data::turn(None, "safe_fallback");
    turn.model_selection = serde_json::from_value(json!({"provider":"openai","model":"gpt-5.5",
        "reasoningEffort":"medium","controls":{},"controlsHash":"hash"}))
    .unwrap();
    let claim = butler_turn::btcc::agent_loop::test_data::claim();
    let (endpoint, bodies, serving) = server(true).await;
    let model = provider(endpoint);
    let progress = Fixture::new([]);
    let cancellation = CancellationToken::new();
    let execution_factory =
        TurnModelExecutionFactory::new(repositories, ModelRouteRetryConfig::new(0.0));
    let execution = execution_factory
        .create(ModelExecutionInput {
            source_revision: butler_turn::btcc::model_route::GuidedSourceRevision::from_turn(&turn),
            turn: &turn,
            claim: &claim,
            progress: progress.as_ref(),
            model_round_observer: &butler_turn::btcc::NOOP_MODEL_ROUND_OBSERVER,
            cancellation: cancellation.clone(),
            base: model.as_ref(),
        })
        .await
        .unwrap();
    let invocation = GuidedInvocation {
        turn: &turn,
        claim: &claim,
        recovery_attempt: 1,
        progress: progress.as_ref(),
        cancellation: &cancellation,
        model_execution: execution.as_ref(),
        operation_results: None,
    };
    let context = ContextPortAdapter::new(
        Arc::new(Steering(progress.clone())),
        Some(ContextCompactionRepository::new(storage.clone())),
    );
    let owner = context.begin_turn(invocation, None).await.unwrap();
    let semantic = [
        ModelRoundMessage::user("request".into(), None),
        ModelRoundMessage::user(format!("HISTORY_SENTINEL {}", "x".repeat(12_000)), None),
        ModelRoundMessage::user("latest".into(), Some("current_user_request".into())),
    ];
    let model_ref = execution.active_model_ref();
    let projection = owner
        .project(
            invocation,
            ContextProjectionInput {
                round_id: "round-fail",
                response_item_id: "turn-item-4",
                semantic_messages: &semantic,
                transport_messages: &semantic,
                model_ref: &model_ref,
                instructions: None,
                tools: &[],
                tool_choice: None,
                attachments: &[],
                butler_data: None,
                max_model_facing_bytes: 4_000,
            },
        )
        .await
        .expect("provider failure must preserve a usable retrieval fallback");
    let ContextMessages::Owned(projected) = &projection.messages else {
        panic!("fallback must materialize")
    };
    assert_eq!(projected.first().unwrap(), &semantic[0]);
    assert_eq!(projected.last().unwrap(), &semantic[2]);
    assert!(projected.iter().any(|message| {
        message.content.contains("Earlier history was elided")
            && message.content.contains("read_operation_results")
    }));
    let captured = bodies.lock().await;
    assert_eq!(captured.len(), 1, "one failing summary request");
    assert!(
        captured[0]
            .0
            .to_string()
            .contains("Summarize the previous summary")
    );
    drop(captured);
    let saved = ContextCompactionRepository::new(storage.clone())
        .load(&turn.turn_id)
        .await
        .unwrap();
    assert_eq!(saved.len(), 1);
    assert!(saved[0].summary.contains("read_operation_results"));
    drop(owner);
    drop(execution);
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("context-native-error-reopen"))
        .await
        .unwrap();
    let restored = ContextCompactionRepository::new(reopened.clone())
        .load(&turn.turn_id)
        .await
        .unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].source_digest, saved[0].source_digest);
    assert_eq!(restored[0].summary, saved[0].summary);
    reopened.close().await.unwrap();
    serving.abort();
}
