use super::*;
use crate::btcc::model_route::{ModelExecution, ModelExecutionView};
use crate::btcc::{ModelIdentity, ReasoningEffort};

struct DirectExecution<'a> {
    model: &'a dyn ModelRoundPort,
}

impl ModelExecutionView for DirectExecution<'_> {
    fn active_model_ref(&self) -> String {
        "openai/gpt-5.5".into()
    }
    fn selected_reasoning_effort(&self) -> ReasoningEffort {
        ReasoningEffort::Medium
    }
    fn accepted_model_identity(&self) -> Option<ModelIdentity> {
        None
    }
}

impl ModelExecution for DirectExecution<'_> {
    fn routed(&self) -> &dyn ModelRoundPort {
        self.model
    }
    fn base(&self) -> &dyn ModelRoundPort {
        self.model
    }
}

#[tokio::test]
async fn nochange_compactor_selects_semantic_and_bounded_eviction_skips_steering_recheck() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("context-selection"))
        .await
        .unwrap();
    let turn = super::super::test_data::turn(None, "safe_fallback");
    let claim = super::super::test_data::claim();
    let ports = Fixture::new([]);
    let execution = DirectExecution {
        model: ports.as_ref(),
    };
    let cancellation = CancellationToken::new();
    let invocation = GuidedInvocation {
        turn: &turn,
        claim: &claim,
        recovery_attempt: 1,
        progress: ports.as_ref(),
        cancellation: &cancellation,
        model_execution: &execution,
        operation_results: None,
    };
    let semantic = [ModelRoundMessage::user("semantic".into(), None)];
    let transport = [ModelRoundMessage::user("transport".into(), None)];
    let compacting = NativeContextPort::new(
        Arc::new(Steering(ports.clone())),
        Some(ContextCompactionRepository::new(storage.clone())),
    );
    let owner = compacting.begin_turn(invocation, None).await.unwrap();
    let projection = owner
        .project(
            invocation,
            ContextProjectionInput {
                round_id: "round-semantic",
                response_item_id: "turn-item-1",
                semantic_messages: &semantic,
                transport_messages: &transport,
                model_ref: "openai/gpt-5.5",
                instructions: None,
                tools: &[],
                tool_choice: None,
                attachments: &[],
                butler_data: None,
                max_model_facing_bytes: 10_000,
            },
        )
        .await
        .unwrap();
    assert!(matches!(projection.messages, ContextMessages::Semantic));
    assert!(!projection.requires_rebase);
    drop(owner);

    let bounded = NativeContextPort::new(Arc::new(Steering(ports.clone())), None);
    let owner = bounded.begin_turn(invocation, None).await.unwrap();
    let transport = [
        ModelRoundMessage::user("request".into(), None),
        ModelRoundMessage::user("x".repeat(2_000), None),
        ModelRoundMessage::user("latest".into(), None),
    ];
    let projection = owner
        .project(
            invocation,
            ContextProjectionInput {
                round_id: "round-bounded",
                response_item_id: "turn-item-2",
                semantic_messages: &semantic,
                transport_messages: &transport,
                model_ref: "openai/gpt-5.5",
                instructions: None,
                tools: &[],
                tool_choice: None,
                attachments: &[],
                butler_data: None,
                max_model_facing_bytes: 300,
            },
        )
        .await
        .unwrap();
    assert!(projection.requires_rebase);
    assert!(!projection.recheck_steering_on_rebase);
    let ContextMessages::Owned(messages) = projection.messages else {
        panic!("eviction materializes")
    };
    assert_eq!(messages.len(), 2);
    drop(owner);
    storage.close().await.unwrap();
}
