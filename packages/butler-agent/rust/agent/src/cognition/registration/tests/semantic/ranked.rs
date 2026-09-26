use super::*;

struct RankedProvider;
impl ProviderPromptPort for RankedProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async move {
            if let Some(intent) = lifecycle.invocation_intent {
                intent.invoked().await?;
            }
            if let Some(entry) = lifecycle.adapter_entry {
                entry.entered()?;
            }
            let prompt: Value = serde_json::from_str(request.prompt).unwrap();
            let source_text = prompt
                .pointer("/parts/0/text")
                .and_then(Value::as_str)
                .unwrap_or("");
            let answer = if prompt.get("targets").is_some()
                || prompt.get("input").and_then(|v| v.get("targets")).is_some()
            {
                serde_json::json!({"decisions":[{"target":"n0","candidate":"n0c0","span":null,"support":["n0u0","n0c0h"]}]})
            } else if source_text.starts_with("abca and abc") {
                serde_json::json!({"status":"processed","entities":[{"name":"abca","evidence":[0]},{"name":"abc","evidence":[0]}],"items":[],"attributes":[]})
            } else if source_text.starts_with("abc is preferred") {
                serde_json::json!({"status":"processed","entities":[{"name":"abc","evidence":[0]}],"items":[],"attributes":[]})
            } else {
                serde_json::json!({"status":"processed","entities":[],"items":[],"attributes":[]})
            };
            Ok(ProviderPromptResult {
                text: answer.to_string(),
                model: "provider/model".into(),
                usage: None,
            })
        })
    }
}

#[tokio::test]
async fn two_window_binding_prefers_exact_alias_over_posting_count_tie() {
    let fixture = Fixture::new("semantic-ranked");
    fixture
        .seed_pair("abca and abc are tools.", "Public answer.")
        .await;
    let facts = Arc::new(Facts::new());
    let coordinator = Arc::new(CognitionWriteCoordinator::new(facts.clone()).unwrap());
    let service = CognitionRegistrationService::with_projection(
        CognitionPathEnvironment::default(),
        coordinator,
        Arc::new(|| NOW.into()),
        Arc::new(RankedProvider),
        Arc::new(NoVectors),
        facts,
    );
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(fixture.input("ranked"))
        .await
        .unwrap()
    else {
        panic!("expected registration")
    };
    let input = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id,
        notice: fixture.input("ranked").notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    service
        .project_semantic_window(input.clone())
        .await
        .unwrap()
        .unwrap();
    service
        .project_semantic_window(input)
        .await
        .unwrap()
        .unwrap();
    let store = fixture.open_store().await;
    store
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "external".into(),
            session_id: Some("session".into()),
            workspace_id: None,
            project_id: Some("project".into()),
            actor: "user".into(),
            request_id: Some("request-2".into()),
            turn_id: Some("turn-2".into()),
            now: Some("2026-09-14T00:01:00.000Z".into()),
        })
        .await
        .unwrap();
    let mut request = message(
        "request-2",
        ConversationRole::User,
        ConversationOriginKind::UserInput,
        "2026-09-14T00:01:01.000Z",
        "abc is preferred.",
    );
    request.turn_id = Some("turn-2".into());
    let request = store.append_user_message(request).await.unwrap();
    let mut reply = message(
        "assistant-2",
        ConversationRole::Assistant,
        ConversationOriginKind::AssistantPublic,
        "2026-09-14T00:01:02.000Z",
        "Second answer.",
    );
    reply.turn_id = Some("turn-2".into());
    let reply = store.append_assistant_message(reply).await.unwrap();
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "turn-2".into(),
            status: Some("complete".into()),
            completed_at: Some("2026-09-14T00:01:03.000Z".into()),
            outcome_capsule: Some(TurnOutcomeCapsuleInput {
                id: Some("outcome-2".into()),
                session_id: "session".into(),
                turn_id: "turn-2".into(),
                generation: 1.0,
                outcome: TurnOutcomeKind::Delivered,
                request_message_id: Some(request.message.id),
                public_assistant_message_id: Some(reply.message.id),
                provider_id: None,
                model_ref: None,
                evidence_refs: vec![],
                unresolved_obligations: vec![],
                continuation: None,
                safe_code: None,
                created_at: Some("2026-09-14T00:01:03.000Z".into()),
            }),
        })
        .await
        .unwrap();
    store.close().await.unwrap();
    let mut second = fixture.input("ranked-2");
    second.notice = CognitionConversationSourceNotice::Turn {
        session_id: "session".into(),
        turn_id: "turn-2".into(),
        outcome_generation: 1.0,
        extraction_version: "v-test".into(),
    };
    let ConversationRegistrationOutcome::Registered(progress) = service
        .register_conversation_source(second.clone())
        .await
        .unwrap()
    else {
        panic!("second registration")
    };
    let second_operation = ProjectSemanticWindowInput {
        data_root: fixture.root.clone(),
        target: MemoryGenerationTarget::Active {
            expected_generation: GENERATION.into(),
        },
        job_id: progress.job_id,
        notice: second.notice.into(),
        cancellation: None,
        deadline_at_epoch_ms: None,
        wait_class: CognitionWaitClass::Background,
    };
    service
        .project_semantic_window(second_operation.clone())
        .await
        .unwrap()
        .unwrap();
    service
        .project_semantic_window(second_operation)
        .await
        .unwrap()
        .unwrap();
    service.close().await;
    let graph = Connection::open(fixture.graph_path()).unwrap();
    let exact:String=graph.query_row("SELECT node_id FROM memory_aliases WHERE surface_original='abc' ORDER BY node_id LIMIT 1",[],|r|r.get(0)).unwrap();
    let weaker:String=graph.query_row("SELECT node_id FROM memory_aliases WHERE surface_original='abca' ORDER BY node_id LIMIT 1",[],|r|r.get(0)).unwrap();
    assert_ne!(exact, weaker);
    let target: String = graph
        .query_row(
            "SELECT target_node_id FROM edges WHERE rel_type='identity_match' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        target, exact,
        "source alias rank must beat a posting-count tie"
    );
}
