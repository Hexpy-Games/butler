use super::*;
use crate::btcc::ContextProjectionError;

#[tokio::test]
async fn native_summary_failure_drops_turn_owner_without_saving() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("context-native-error"))
        .await
        .unwrap();
    let repositories = Arc::new(BtccRepositories::new(storage.clone(), None));
    let mut turn = super::super::test_data::turn(None, "safe_fallback");
    turn.model_selection = json!({"provider":"openai","model":"gpt-5.5",
        "reasoningEffort":"medium","controls":{},"controlsHash":"hash"});
    let claim = super::super::test_data::claim();
    let (endpoint, bodies, serving) = server(true).await;
    let model = provider(endpoint);
    let progress = Fixture::new([]);
    let cancellation = CancellationToken::new();
    let execution_factory =
        TurnModelExecutionFactory::new(repositories, ModelRouteRetryConfig::new(0.0));
    let execution = execution_factory
        .create(ModelExecutionInput {
            source_revision: crate::btcc::model_route::GuidedSourceRevision::from_turn(&turn),
            turn: &turn,
            claim: &claim,
            progress: progress.as_ref(),
            model_round_observer: &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
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
    let context = NativeContextPort::new(
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
    let error = owner
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
        .err()
        .expect("summary provider failure");
    assert!(matches!(error, ContextProjectionError::Model(_)));
    assert!(!bodies.lock().await.is_empty());
    assert!(
        ContextCompactionRepository::new(storage.clone())
            .load(&turn.turn_id)
            .await
            .unwrap()
            .is_empty()
    );
    drop(owner);
    drop(execution);
    storage.close().await.unwrap();
    let reopened = BtccStorage::open(fixture.config("context-native-error-reopen"))
        .await
        .unwrap();
    assert!(
        ContextCompactionRepository::new(reopened.clone())
            .load(&turn.turn_id)
            .await
            .unwrap()
            .is_empty()
    );
    reopened.close().await.unwrap();
    serving.abort();
}
