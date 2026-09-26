use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::admission::{
    AdmissionEventVisibility, AdmissionMetric, CompletionMetric, CompletionObservation,
    ConversationAdmissionObserver, ConversationAdmissionTurnInput, ConversationEnvelope,
    ConversationObserverFuture, ConversationOriginFacts, DurableSessionBinding,
    RuntimeAdmissionEvent, classify_conversation_origin,
};
use super::codec::source_hash;
use super::*;

struct TestClock {
    next: AtomicU64,
    forced_outbox: Mutex<Option<String>>,
}

impl TestClock {
    fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            forced_outbox: Mutex::new(None),
        }
    }
}

impl ConversationIdentityClock for TestClock {
    fn id(&self, prefix: &'static str) -> String {
        if prefix == "cpo"
            && let Some(id) = self.forced_outbox.lock().unwrap().clone()
        {
            return id;
        }
        format!(
            "{prefix}_{}",
            self.next.fetch_add(1, AtomicOrdering::Relaxed)
        )
    }

    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
}

struct TestCollation;
impl ConversationLocaleCollation for TestCollation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

#[derive(Default)]
struct TestObserver {
    admissions: AtomicU64,
    completions: AtomicU64,
    metrics: AtomicU64,
}

impl ConversationAdmissionObserver for TestObserver {
    fn admission_metric<'a>(&'a self, _: AdmissionMetric) -> ConversationObserverFuture<'a> {
        self.admissions.fetch_add(1, AtomicOrdering::Relaxed);
        Box::pin(async { Ok(()) })
    }

    fn completion_observation<'a>(
        &'a self,
        _: CompletionObservation,
    ) -> ConversationObserverFuture<'a> {
        self.completions.fetch_add(1, AtomicOrdering::Relaxed);
        Box::pin(async { Ok(()) })
    }

    fn completion_metric<'a>(&'a self, _: CompletionMetric) -> ConversationObserverFuture<'a> {
        self.metrics.fetch_add(1, AtomicOrdering::Relaxed);
        Box::pin(async { Ok(()) })
    }
}

fn test_path(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-conversation-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed)
    ))
}

async fn open_at(path: PathBuf) -> (AgentConversationStore, Arc<TestClock>, Arc<TestCollation>) {
    let clock = Arc::new(TestClock::new());
    let collation = Arc::new(TestCollation);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path,
        identity_clock: clock.clone(),
        collation: collation.clone(),
    })
    .await
    .unwrap();
    (store, clock, collation)
}

fn begin_input() -> BeginTurnInput {
    BeginTurnInput {
        gateway: "app".into(),
        external_session_id: "runtime-1".into(),
        session_id: Some("cs_fixed".into()),
        workspace_id: None,
        project_id: Some("project-1".into()),
        actor: "user".into(),
        request_id: Some("event-1".into()),
        turn_id: Some("ct_fixed".into()),
        now: Some("2026-09-14T00:00:00.000Z".into()),
    }
}

fn append_input(message_id: &str, text: &str) -> AppendMessageInput {
    AppendMessageInput {
        session_id: "cs_fixed".into(),
        turn_id: Some("ct_fixed".into()),
        text: text.into(),
        message_id: Some(message_id.into()),
        role: ConversationRole::User,
        status: None,
        visibility: None,
        provenance: None,
        source_gateway: Some("app".into()),
        source_ref: Some("event-1".into()),
        origin_kind: Some(ConversationOriginKind::UserInput),
        origin_ref: Some("app:event-1".into()),
        origin_reason: Some("verified_public_ingress".into()),
        origin_version: Some("conversation-origin-v1".into()),
        origin_evidence: None,
        now: Some("2026-09-14T00:00:00.000Z".into()),
        parts: None,
    }
}

#[tokio::test]
async fn projection_message_pages_use_canonical_sequences_and_report_more_rows() {
    let path = test_path("projection-pages");
    let (store, _, _) = open_at(path.clone()).await;
    store.begin_turn(begin_input()).await.unwrap();
    for index in 1..=5 {
        store
            .append_user_message(append_input(
                &format!("message-{index}"),
                &format!("text-{index}"),
            ))
            .await
            .unwrap();
    }
    let latest = store
        .read_projection_message_page("cs_fixed", None, None, 2)
        .await
        .unwrap();
    assert_eq!(
        latest
            .messages
            .iter()
            .map(|row| row.message.seq)
            .collect::<Vec<_>>(),
        vec![4, 5]
    );
    assert!(latest.has_more);
    let previous = store
        .read_projection_message_page("cs_fixed", None, Some(4), 2)
        .await
        .unwrap();
    assert_eq!(
        previous
            .messages
            .iter()
            .map(|row| row.message.seq)
            .collect::<Vec<_>>(),
        vec![2, 3]
    );
    assert!(previous.has_more);
    let delta = store
        .read_projection_message_page("cs_fixed", Some(3), None, 2)
        .await
        .unwrap();
    assert_eq!(
        delta
            .messages
            .iter()
            .map(|row| row.message.seq)
            .collect::<Vec<_>>(),
        vec![4, 5]
    );
    assert!(!delta.has_more);
    store.close().await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[test]
fn source_hash_matches_real_typescript_fixture_and_origin_json_uses_ref() {
    let message = ConversationMessageWithParts {
        message: ConversationMessage {
            id: "cm_fixed".into(),
            session_id: "cs_fixed".into(),
            turn_id: Some("ct_fixed".into()),
            seq: 1,
            role: ConversationRole::User,
            status: ConversationStatus::Complete,
            visibility: ConversationVisibility::Model,
            provenance: ConversationProvenance::Trusted,
            created_at: "2026-09-14T00:00:00.000Z".into(),
            compacted_by_summary_id: None,
            source_gateway: Some("app".into()),
            source_ref: Some("evt-1".into()),
            origin_kind: ConversationOriginKind::UserInput,
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence_json: None,
        },
        parts: vec![ConversationPart {
            id: "cp_fixed".into(),
            message_id: "cm_fixed".into(),
            part_index: 0,
            kind: ConversationPartKind::MessageContent,
            content_json: json!([{"type":"input_text","text":"😀 hello"},{"type":"input_image","image_url":"x"}]),
            tool_call_id: None,
            parent_tool_call_id: None,
            provider_shape: None,
            status: ConversationStatus::Complete,
        }],
    };
    assert_eq!(
        source_hash(&[message]).unwrap(),
        "sha256:16fc61280bb8ad71e8ba74e927393b0105ee5bb927da265173311aacd342da97"
    );
    let evidence = ConversationOriginEvidence {
        reference: "wake:1".into(),
        kind: "authorized_wake".into(),
        sha256: None,
    };
    assert_eq!(
        crate::json::stringify(&serde_json::to_value([evidence]).unwrap()).unwrap(),
        "[{\"ref\":\"wake:1\",\"kind\":\"authorized_wake\",\"sha256\":null}]"
    );
}

mod admission;
mod historical_recovery;
mod lifecycle;
mod store;
