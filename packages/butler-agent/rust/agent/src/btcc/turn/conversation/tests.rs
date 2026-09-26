use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use serde_json::json;

use super::*;
use crate::conversation::{
    AdmissionMetric, CompletionMetric, CompletionObservation, ConversationAdmissionObserver,
    ConversationAdmissionTurnInput, ConversationEnvelope, ConversationObserverFuture,
    ConversationOriginEvidence, ConversationOriginFacts, ConversationStoreConfig,
    DurableSessionBinding, ReadMessagesInput, classify_conversation_origin,
};
use crate::host::SystemIdentity;
use crate::locale::LocaleCollation;

#[derive(Default)]
struct Observer {
    completions: AtomicUsize,
}
impl ConversationAdmissionObserver for Observer {
    fn admission_metric(&self, _: AdmissionMetric) -> ConversationObserverFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn completion_observation(&self, _: CompletionObservation) -> ConversationObserverFuture<'_> {
        self.completions.fetch_add(1, Ordering::Relaxed);
        Box::pin(async { Ok(()) })
    }
    fn completion_metric(&self, _: CompletionMetric) -> ConversationObserverFuture<'_> {
        Box::pin(async { Ok(()) })
    }
}

struct Fixture {
    root: PathBuf,
    store: AgentConversationStore,
    observer: Arc<Observer>,
}
impl Fixture {
    async fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-prepared-conversation-{}",
            uuid::Uuid::new_v4()
        ));
        let store = AgentConversationStore::open(ConversationStoreConfig {
            path: root.join("conversation.sqlite"),
            identity_clock: Arc::new(SystemIdentity),
            collation: Arc::new(LocaleCollation::new("en-US").unwrap()),
        })
        .await
        .unwrap();
        Self {
            root,
            store,
            observer: Arc::new(Observer::default()),
        }
    }
    async fn prepare(&self, turn_id: &str) -> ConversationProjection {
        let origin = classify_conversation_origin(
            self.store.collation().as_ref(),
            ConversationOriginFacts {
                reference: Some(format!("btcc:{turn_id}:input")),
                public_ingress: true,
                internal_control: false,
                evidence_available: true,
                evidence: vec![ConversationOriginEvidence {
                    reference: format!("btcc:{turn_id}:input"),
                    kind: "btcc_admission".into(),
                    sha256: None,
                }],
            },
        );
        let admission = ConversationAdmissionTurn::begin(ConversationAdmissionTurnInput {
            store: self.store.clone(),
            binding: DurableSessionBinding {
                session_id: format!("session-{turn_id}"),
                project_id: None,
                role: "butler".into(),
                model_ref: "openai/test".into(),
            },
            envelope: ConversationEnvelope {
                transport: "app".into(),
                event_id: format!("event-{turn_id}"),
                message_text: "remember the test value".into(),
                content_parts: None,
            },
            turn_id: turn_id.into(),
            timestamp: self.store.identity_clock().now_iso(),
            origin,
            observer: self.observer.clone(),
        })
        .await
        .unwrap();
        admission.admit_inbound().await.unwrap();
        ConversationProjection::new(admission, self.store.clone(), turn_id.into())
    }
    async fn close(self) {
        self.store.close().await.unwrap();
        drop(self.store);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

fn delivered(turn_id: &str, content: &str) -> TurnOutcome {
    serde_json::from_value(json!({
        "kind":"delivered", "turnId":turn_id, "messageId":"canonical-final", "content":content,
    }))
    .unwrap()
}

#[tokio::test]
async fn delivered_replay_skips_final_admission_generation_and_completion_observation() {
    let fixture = Fixture::open().await;
    let projection = fixture.prepare("delivered").await;
    let observer = Arc::downgrade(&fixture.observer);
    projection
        .complete(delivered("delivered", "The test value is remembered."))
        .await
        .unwrap();
    let original = fixture
        .store
        .read_turn_outcome("delivered")
        .await
        .unwrap()
        .unwrap();
    let messages = fixture
        .store
        .read_messages(ReadMessagesInput {
            session_id: original.session_id.clone(),
            limit: None,
            include_compacted: true,
        })
        .await
        .unwrap();
    assert_eq!(original.generation, 1.0);
    assert_eq!(messages.len(), 2);
    drop(projection);
    // A newly prepared replay has its own local admission owner but must use
    // the already delivered durable fact before trying a conflicting final.
    let replay = fixture.prepare("delivered").await;
    replay
        .complete(delivered(
            "delivered",
            "A different replay must not be admitted.",
        ))
        .await
        .unwrap();
    assert_eq!(
        fixture
            .store
            .read_turn_outcome("delivered")
            .await
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(
        fixture
            .store
            .read_messages(ReadMessagesInput {
                session_id: original.session_id.clone(),
                limit: None,
                include_compacted: true,
            })
            .await
            .unwrap(),
        messages
    );
    assert_eq!(fixture.observer.completions.load(Ordering::Relaxed), 1);
    drop(replay);
    fixture.close().await;
    assert!(observer.upgrade().is_none());
}

#[tokio::test]
async fn cancellation_replay_does_not_increment_the_canonical_outcome_generation() {
    let fixture = Fixture::open().await;
    let projection = fixture.prepare("cancelled").await;
    projection.cancel().await.unwrap();
    let original = fixture
        .store
        .read_turn_outcome("cancelled")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(original.outcome, ConversationOutcome::Cancelled);
    assert_eq!(original.generation, 1.0);
    drop(projection);
    let replay = fixture.prepare("cancelled").await;
    replay.cancel().await.unwrap();
    assert_eq!(
        fixture
            .store
            .read_turn_outcome("cancelled")
            .await
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(fixture.observer.completions.load(Ordering::Relaxed), 0);
    drop(replay);
    fixture.close().await;
}
