use std::{
    cmp::Ordering,
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
};

use crate::conversation::{
    AgentConversationStore, AppendMessageInput, BeginTurnInput, ConversationIdentityClock,
    ConversationLocaleCollation, ConversationOriginKind, ConversationRole, ConversationStoreConfig,
    ConversationSummaryInput,
};

use super::{StatusFact, read_status_conversation_facts, read_status_transcript_summary};

struct Clock(AtomicU64);

impl ConversationIdentityClock for Clock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", self.0.fetch_add(1, AtomicOrdering::Relaxed))
    }

    fn now_iso(&self) -> String {
        "2026-09-23T00:00:00.000Z".into()
    }
}

struct Collation;

impl ConversationLocaleCollation for Collation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(std::env::temp_dir().join(format!(
            "butler-context-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, AtomicOrdering::Relaxed)
        )))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn existing_conversation_summary_is_projected_without_database_writes() {
    let fixture = Fixture::new();
    let database = fixture.0.join("runtime/conversation-store.sqlite");
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: database.clone(),
        identity_clock: Arc::new(Clock(AtomicU64::new(1))),
        collation: Arc::new(Collation),
    })
    .await
    .unwrap();
    store
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "status-fixture".into(),
            session_id: Some("butler/main".into()),
            workspace_id: None,
            project_id: None,
            actor: "user".into(),
            request_id: Some("request-1".into()),
            turn_id: Some("turn-1".into()),
            now: Some("2026-09-23T00:00:00.000Z".into()),
        })
        .await
        .unwrap();
    let message = store
        .append_user_message(AppendMessageInput {
            session_id: "butler/main".into(),
            turn_id: Some("turn-1".into()),
            text: "hello status".into(),
            message_id: Some("message-1".into()),
            role: ConversationRole::User,
            status: None,
            visibility: None,
            provenance: None,
            source_gateway: Some("app".into()),
            source_ref: Some("request-1".into()),
            origin_kind: Some(ConversationOriginKind::UserInput),
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence: None,
            now: Some("2026-09-23T00:00:00.000Z".into()),
            parts: None,
        })
        .await
        .unwrap();
    let source_hash = store
        .conversation_messages_source_hash(vec![message.message.id])
        .await
        .unwrap();
    store
        .write_summary(ConversationSummaryInput {
            session_id: "butler/main".into(),
            covers_from_seq: 1.0,
            covers_to_seq: 1.0,
            source_hash,
            summary_text: "brief".into(),
            model: None,
            summary_id: Some("summary-1".into()),
            now: Some("2026-09-23T00:00:01.000Z".into()),
        })
        .await
        .unwrap();
    store.close().await.unwrap();

    let before = fs::read(&database).unwrap();
    let facts = read_status_conversation_facts(&fixture.0, "butler/main");
    let after = fs::read(&database).unwrap();

    assert_eq!(facts.active_session, StatusFact::Available(None));
    assert_eq!(facts.active_transcript_tokens, StatusFact::Available(0));
    assert_eq!(facts.conversation.exists, Some(true));
    assert_eq!(facts.conversation.session_id, "butler/main");
    assert_eq!(facts.conversation.semantic_messages, Some(0));
    assert_eq!(facts.conversation.compacted_messages, Some(1));
    assert_eq!(facts.conversation.summaries, Some(1));
    assert_eq!(facts.conversation.prompt_token_estimate, Some(2));
    assert_eq!(facts.conversation.unavailable_reason, None);
    assert!(before == after, "status changed the conversation database");
    assert!(!fixture.0.join("runtime/session-store.sqlite").exists());
}

#[test]
fn transcript_summary_streams_jsonl_without_creating_the_source_index() {
    let fixture = Fixture::new();
    let transcript = fixture.0.join("transcripts/butler_main.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let contents = concat!(
        "{\"kind\":\"inbound\",\"timestamp\":\"2026-09-23T01:00:00Z\"}\n",
        "not-json\n",
        "42\n",
        "{\"kind\":\"tick\",\"timestamp\":\"2026-09-23T02:00:00Z\"}\n",
        "{\"kind\":\"outbound\"}"
    );
    fs::write(&transcript, contents).unwrap();

    let summary = read_status_transcript_summary(&fixture.0, "butler/main");

    assert_eq!(summary.exists, Some(true));
    assert_eq!(summary.bytes, Some(contents.len() as u64));
    assert_eq!(summary.events, Some(3));
    assert_eq!(summary.conversation_events, Some(2));
    assert_eq!(
        summary.latest_timestamp.as_deref(),
        Some("2026-09-23T02:00:00Z")
    );
    assert_eq!(summary.parse_errors, Some(2));
    assert_eq!(summary.unavailable_reason, None);
    assert!(!fixture.0.join("metrics/transcript-summary").exists());
}
