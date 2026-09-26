use std::sync::Arc;

use serde_json::Value;

use super::*;
use crate::conversation::{
    AgentConversationStore, ConversationAdmissionTurn, ConversationAdmissionTurnInput,
    ConversationEnvelope, ConversationOriginEvidence, ConversationOriginFacts,
    ConversationStoreConfig, DurableSessionBinding, classify_conversation_origin,
};
use crate::locale::LocaleCollation;

#[tokio::test]
async fn canonical_completion_publishes_one_observation_and_one_queue_job_then_drains() {
    let root = std::env::temp_dir().join(format!("butler-completion-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    let clock = Arc::new(super::super::SystemIdentity);
    let collation = Arc::new(LocaleCollation::new("en").unwrap());
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: root.join("runtime/conversation-store.sqlite"),
        identity_clock: clock.clone(),
        collation: collation.clone(),
    })
    .await
    .unwrap();
    let observer = Arc::new(
        NativeConversationObserver::new(
            &root.clone(),
            &CognitionPathEnvironment::default(),
            clock,
            Arc::new(crate::operations::MetricFiles::new(root.clone())),
        )
        .unwrap(),
    );
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
                sha256: None,
            }],
        },
    );
    let turn = ConversationAdmissionTurn::begin(ConversationAdmissionTurnInput {
        store: store.clone(),
        binding: DurableSessionBinding {
            session_id: "runtime-first-user".into(),
            project_id: None,
            role: "primary".into(),
            model_ref: "openai/test".into(),
        },
        envelope: ConversationEnvelope {
            transport: "app".into(),
            event_id: "event-1".into(),
            message_text: "original user message".into(),
            content_parts: None,
        },
        turn_id: "ct_first_user".into(),
        timestamp: "2026-09-19T00:00:00.000Z".into(),
        origin,
        observer: observer.clone(),
    })
    .await
    .unwrap();
    turn.admit_inbound().await.unwrap();
    turn.admit_final("original assistant answer", "final-1")
        .await
        .unwrap();
    turn.finalize("complete", "2026-09-19T00:00:01.000Z")
        .await
        .unwrap();
    let canonical = store
        .read_turn_outcome("ct_first_user")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(canonical.generation, 1.0);
    observer.close().await.unwrap();
    store.close().await.unwrap();

    let directory = root.join("cognition/memory/queue/completion-observations");
    let paths = std::fs::read_dir(directory)
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(paths.len(), 1);
    let notice: Value =
        serde_json::from_str(&std::fs::read_to_string(paths[0].path()).unwrap()).unwrap();
    assert_eq!(notice["scope"], "global");
    assert_eq!(notice["conversation_turn_id"], "ct_first_user");
    assert_eq!(notice["outcome_generation"], 1);
    assert!(notice.get("original user message").is_none());
    let queue = std::fs::read_to_string(root.join("cognition/memory/queue/sync.jsonl")).unwrap();
    let lines: Vec<_> = queue.lines().collect();
    assert_eq!(lines.len(), 1);
    let job: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(job["job_id"], notice["job_id"]);
    assert_eq!(
        job["source"]["session_id"],
        notice["conversation_session_id"]
    );
    assert_eq!(job["source"]["turn_id"], "ct_first_user");
    assert!(!queue.contains("original user message"));
    assert!(!queue.contains("original assistant answer"));
    std::fs::remove_dir_all(root).unwrap();
}
