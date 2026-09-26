use super::*;
use serde_json::{Map, Value};

async fn session_messages(store: &AgentConversationStore) -> Vec<ConversationMessageWithParts> {
    store
        .read_messages(ReadMessagesInput {
            session_id: "cs_168957e8d7dc810a091762d5cd16db9d".into(),
            limit: None,
            include_compacted: true,
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn admission_replays_exact_source_and_rejects_unsafe_tool_content() {
    let path = test_path("admission");
    let (store, _, collation) = open_at(path.clone()).await;
    let observer = Arc::new(TestObserver::default());
    let weak_observer = Arc::downgrade(&observer);
    let origin = classify_conversation_origin(
        collation.as_ref(),
        ConversationOriginFacts {
            reference: Some("app:event-1".into()),
            public_ingress: true,
            internal_control: false,
            evidence_available: true,
            evidence: vec![ConversationOriginEvidence {
                reference: "app:event-1".into(),
                kind: "app_ingress".into(),
                sha256: Some("sha".into()),
            }],
        },
    );
    let make_input = |text: &str, observer: Arc<TestObserver>| ConversationAdmissionTurnInput {
        store: store.clone(),
        binding: DurableSessionBinding {
            session_id: "runtime-1".into(),
            project_id: Some("project-1".into()),
            role: "primary".into(),
            model_ref: "openai/gpt".into(),
        },
        envelope: ConversationEnvelope {
            transport: "app".into(),
            event_id: "event-1".into(),
            message_text: text.into(),
            content_parts: Some(json!([{"type":"input_text","text":text}])),
        },
        turn_id: "ct_admission".into(),
        timestamp: "2026-09-14T00:00:00.000Z".into(),
        origin: origin.clone(),
        observer,
    };
    let admission = ConversationAdmissionTurn::begin(make_input("hello", observer.clone()))
        .await
        .unwrap();
    admission.admit_inbound().await.unwrap();
    admission.admit_inbound().await.unwrap();
    let admitted_messages = session_messages(&store).await;
    assert_eq!(admitted_messages.len(), 1);
    assert_eq!(
        admitted_messages[0].message.session_id,
        "cs_168957e8d7dc810a091762d5cd16db9d"
    );
    assert_eq!(
        admitted_messages[0].message.turn_id.as_deref(),
        Some("ct_admission")
    );
    assert!(!admitted_messages[0].message.id.is_empty());
    let conflict = ConversationAdmissionTurn::begin(make_input("changed", observer.clone()))
        .await
        .unwrap();
    assert_eq!(
        conflict.admit_inbound().await.unwrap_err().code,
        "conversation_source_ref_conflict"
    );

    let mut evidence = Map::new();
    evidence.insert("nested".into(), json!({"digest":"digest-nested"}));
    evidence.insert("packet_id".into(), "packet-top".into());
    evidence.insert("artifact_id".into(), "artifact-top".into());
    evidence.insert("digest".into(), "digest-top".into());
    evidence.insert("duplicate".into(), json!({"artifact_id":"artifact-top"}));
    let result = Map::from_iter([
        (
            "schema_version".into(),
            "butler.tool-result-evidence-transcript.v1".into(),
        ),
        (
            "evidence_receipts".into(),
            Value::Array(vec![
                Value::Object(evidence),
                json!({"artifact_id":"artifact-top"}),
            ]),
        ),
        ("rawStdout".into(), "SECRET_TOKEN=x".into()),
    ]);
    let orphan_payload = Map::from_iter([
        ("toolCallId".into(), "call-1".into()),
        ("result".into(), Value::Object(result)),
    ]);
    let orphan = RuntimeAdmissionEvent {
        kind: "tool_result.finalized",
        payload: Some(&orphan_payload),
        visibility: Some(AdmissionEventVisibility::Internal),
    };
    admission.record_event(orphan).await.unwrap();
    assert_eq!(session_messages(&store).await.len(), 1);
    let call_payload = json!({"toolCallId":"call-1","arguments":{"schema_version":"butler.tool-call-arguments-transcript.v1","safe_arguments":{"token":"secret-value","query":"public"}}})
        .as_object()
        .cloned()
        .unwrap();
    let call = RuntimeAdmissionEvent {
        kind: "tool_call.finalized",
        payload: Some(&call_payload),
        visibility: Some(AdmissionEventVisibility::Internal),
    };
    admission.record_event(call).await.unwrap();
    admission.record_event(orphan).await.unwrap();
    let encoded = format!("{:?}", session_messages(&store).await);
    assert!(!encoded.contains("secret-value"));
    assert!(!encoded.contains("SECRET_TOKEN"));
    admission
        .admit_final("done", "btcc-canonical-final:message-1")
        .await
        .unwrap();
    admission
        .finalize("complete", "2026-09-14T00:00:02.000Z")
        .await
        .unwrap();
    let outcome = store
        .read_turn_outcome("ct_admission")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.outcome, TurnOutcomeKind::Delivered);
    assert_eq!(
        outcome.evidence_refs,
        vec!["artifact-top", "packet-top", "digest-top", "digest-nested"]
    );
    assert_eq!(observer.admissions.load(AtomicOrdering::Relaxed), 7);
    assert_eq!(observer.completions.load(AtomicOrdering::Relaxed), 1);
    assert_eq!(observer.metrics.load(AtomicOrdering::Relaxed), 1);
    drop(conflict);
    drop(admission);
    drop(observer);
    assert!(weak_observer.upgrade().is_none());
    store.close().await.unwrap();
    let _ignored_cleanup = std::fs::remove_file(path);
}
