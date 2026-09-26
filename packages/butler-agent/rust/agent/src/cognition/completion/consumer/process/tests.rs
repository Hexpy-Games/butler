use std::{
    cmp::Ordering,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
    time::Instant,
};

use rusqlite::Connection;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::{Input, poll};
use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionRegistrationService, initialize_empty_memory_generation,
    },
    conversation::{
        AgentConversationStore, AppendMessageInput, BeginTurnInput, ConversationIdentityClock,
        ConversationLocaleCollation, ConversationOriginKind, ConversationPartKind,
        ConversationProvenance, ConversationRole, ConversationStatus, ConversationStoreConfig,
        FinalizeTurnInput, MessagePartInput, TurnOutcomeCapsuleInput, TurnOutcomeKind,
    },
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteCoordinator,
        CoordinationResult,
    },
};

const NOW: &str = "2026-09-23T00:00:04.000Z";

struct Facts(AtomicU64);

impl CognitionCoordinationHost for Facts {
    fn process_id(&self) -> u32 {
        std::process::id()
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("queue-catchup-test".into())
    }
    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-0000-0000-{:012}",
            self.0.fetch_add(1, AtomicOrdering::Relaxed)
        )
    }
    fn now_epoch_millis(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }
    fn now_iso(&self) -> String {
        NOW.into()
    }
}

struct ConversationClock(AtomicU64);

impl ConversationIdentityClock for ConversationClock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", self.0.fetch_add(1, AtomicOrdering::Relaxed))
    }
    fn now_iso(&self) -> String {
        NOW.into()
    }
}

struct Collation;

impl ConversationLocaleCollation for Collation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

struct Fixture {
    root: PathBuf,
    conversation_clock: Arc<ConversationClock>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            root: std::env::temp_dir().join(format!(
                "butler-completion-catchup-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            )),
            conversation_clock: Arc::new(ConversationClock(AtomicU64::new(1))),
        }
    }

    async fn seed_canonical_outcome(&self) {
        let store = AgentConversationStore::open(ConversationStoreConfig {
            path: self.root.join("runtime/conversation-store.sqlite"),
            identity_clock: self.conversation_clock.clone(),
            collation: Arc::new(Collation),
        })
        .await
        .unwrap();
        store
            .begin_turn(BeginTurnInput {
                gateway: "app".into(),
                external_session_id: "external".into(),
                session_id: Some("session".into()),
                workspace_id: None,
                project_id: Some("project".into()),
                actor: "user".into(),
                request_id: Some("request".into()),
                turn_id: Some("turn".into()),
                now: Some("2026-09-23T00:00:00.000Z".into()),
            })
            .await
            .unwrap();
        let request = store
            .append_user_message(message(
                "request",
                ConversationRole::User,
                ConversationOriginKind::UserInput,
                "2026-09-23T00:00:01.000Z",
                "Remember this outcome",
            ))
            .await
            .unwrap();
        let answer = store
            .append_assistant_message(message(
                "assistant",
                ConversationRole::Assistant,
                ConversationOriginKind::AssistantPublic,
                "2026-09-23T00:00:02.000Z",
                "Public answer",
            ))
            .await
            .unwrap();
        store
            .finalize_turn(FinalizeTurnInput {
                turn_id: "turn".into(),
                status: Some("complete".into()),
                completed_at: Some("2026-09-23T00:00:03.000Z".into()),
                outcome_capsule: Some(TurnOutcomeCapsuleInput {
                    id: Some("outcome".into()),
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    generation: 1.0,
                    outcome: TurnOutcomeKind::Delivered,
                    request_message_id: Some(request.message.id),
                    public_assistant_message_id: Some(answer.message.id),
                    provider_id: None,
                    model_ref: None,
                    evidence_refs: Vec::new(),
                    unresolved_obligations: Vec::new(),
                    continuation: None,
                    safe_code: None,
                    created_at: Some("2026-09-23T00:00:03.000Z".into()),
                }),
            })
            .await
            .unwrap();
        store.close().await.unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn message(
    id: &str,
    role: ConversationRole,
    origin: ConversationOriginKind,
    now: &str,
    text: &str,
) -> AppendMessageInput {
    AppendMessageInput {
        session_id: "session".into(),
        turn_id: Some("turn".into()),
        text: String::new(),
        message_id: Some(id.into()),
        role,
        status: Some(ConversationStatus::Complete),
        visibility: None,
        provenance: Some(ConversationProvenance::Trusted),
        source_gateway: Some("app".into()),
        source_ref: Some(id.into()),
        origin_kind: Some(origin),
        origin_ref: None,
        origin_reason: None,
        origin_version: None,
        origin_evidence: None,
        now: Some(now.into()),
        parts: Some(vec![MessagePartInput {
            kind: ConversationPartKind::Text,
            content_json: json!({"text":text}),
            tool_call_id: None,
            parent_tool_call_id: None,
            provider_shape: None,
            status: Some(ConversationStatus::Complete),
        }]),
    }
}

#[tokio::test]
async fn malformed_queue_head_keeps_its_error_after_canonical_catchup() {
    let fixture = Fixture::new();
    let environment = CognitionPathEnvironment::default();
    let coordinator =
        Arc::new(CognitionWriteCoordinator::new(Arc::new(Facts(AtomicU64::new(1)))).unwrap());
    let generation = initialize_empty_memory_generation(
        fixture.root.clone(),
        environment.clone(),
        coordinator.clone(),
        Arc::new(|| NOW.into()),
        "test-unicode".into(),
        "test-icu".into(),
    )
    .await
    .unwrap();
    std::fs::write(
        fixture.root.join("butler.config.json"),
        json!({"personalization":{"profiling":{"extractorModel":"provider/model","extractorReasoningEffort":"high"}}}).to_string(),
    )
    .unwrap();
    fixture.seed_canonical_outcome().await;

    let queue_path = environment
        .memory_root(&fixture.root)
        .join("queue/sync.jsonl");
    std::fs::create_dir_all(queue_path.parent().unwrap()).unwrap();
    let malformed =
        "{\"schema_version\":\"butler.memory-sync-request.v1\",\"job_id\":\"legacy\"}\n";
    std::fs::write(&queue_path, malformed).unwrap();

    let registration = Arc::new(CognitionRegistrationService::new(
        environment.clone(),
        coordinator.clone(),
        Arc::new(|| NOW.into()),
    ));
    let result = poll(Input {
        data_root: fixture.root.clone(),
        environment,
        registration: registration.clone(),
        embedding: None,
        target: None,
        coordinator,
        clock: Arc::new(|| NOW.into()),
        catchup_at: Arc::new(std::sync::Mutex::new(None::<Instant>)),
        shutdown: CancellationToken::new(),
    })
    .await;
    registration.close().await;

    let error = result.expect_err("malformed queue entry remains the primary failure");
    assert_eq!(error.code, "memory_sync_legacy_entry_unsupported");
    assert_eq!(std::fs::read_to_string(queue_path).unwrap(), malformed);
    let cursor: String = Connection::open(generation.graph_path)
        .unwrap()
        .query_row(
            "SELECT value FROM memory_state WHERE key='canonical_catchup_outcome_cursor'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(cursor, "outcome");
}
