use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use rusqlite::Connection;
use serde_json::json;

use super::*;
use crate::cognition::{CognitionConversationSourceNotice, MemoryGenerationTarget};
use crate::conversation::{
    AgentConversationStore, AppendMessageInput, BeginTurnInput, ConversationIdentityClock,
    ConversationLocaleCollation, ConversationOriginKind, ConversationPartKind,
    ConversationProvenance, ConversationRole, ConversationStatus, ConversationStoreConfig,
    FinalizeTurnInput, MessagePartInput, TurnOutcomeCapsuleInput, TurnOutcomeKind,
};
use crate::coordination::{
    CognitionCoordinationHost, CognitionProcessStatus, CognitionWaitClass, CognitionWriteAcquire,
    CognitionWriteCoordinator, CoordinationResult,
};

const GENERATION: &str = "11111111-1111-1111-1111-111111111111";
const NOW: &str = "2026-09-14T00:00:04.000Z";

struct Facts {
    ids: AtomicU64,
    now_calls: AtomicU64,
}

impl Facts {
    fn new() -> Self {
        Self {
            ids: AtomicU64::new(1),
            now_calls: AtomicU64::new(0),
        }
    }
}
impl CognitionCoordinationHost for Facts {
    fn process_id(&self) -> u32 {
        42
    }
    fn hostname(&self) -> CoordinationResult<String> {
        Ok("fixture-host".into())
    }
    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }
    fn new_uuid(&self) -> String {
        format!(
            "00000000-0000-0000-0000-{:012}",
            self.ids.fetch_add(1, AtomicOrdering::Relaxed)
        )
    }
    fn now_epoch_millis(&self) -> i64 {
        self.now_calls.fetch_add(1, AtomicOrdering::Release);
        i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap_or(i64::MAX)
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
    clock: Arc<ConversationClock>,
}
impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-cognition-registration-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        Self {
            root,
            clock: Arc::new(ConversationClock(AtomicU64::new(1))),
        }
    }
    fn canonical_path(&self) -> PathBuf {
        self.root.join("runtime/conversation-store.sqlite")
    }
    fn graph_path(&self) -> PathBuf {
        self.root
            .join("cognition/memory/generations")
            .join(GENERATION)
            .join("graph.sqlite")
    }
    fn lock_path(&self) -> PathBuf {
        self.root
            .join("cognition/consolidation/locks/consolidation.lock")
    }
    async fn seed(&self) {
        self.seed_with_text("Straße remembers 🙂").await;
    }

    async fn seed_with_text(&self, request_text: &str) {
        self.seed_pair(request_text, "Public answer").await;
    }

    async fn seed_pair(&self, request_text: &str, assistant_text: &str) {
        self.seed_pair_with_origin(
            request_text,
            assistant_text,
            ConversationOriginKind::UserInput,
        )
        .await;
    }

    async fn seed_pair_with_origin(
        &self,
        request_text: &str,
        assistant_text: &str,
        request_origin: ConversationOriginKind,
    ) {
        std::fs::create_dir_all(self.graph_path().parent().unwrap()).unwrap();
        Connection::open(self.graph_path())
            .unwrap()
            .close()
            .unwrap();
        std::fs::write(
            self.root.join("cognition/memory/active-generation.json"),
            json!({
                "schema":"butler.memory-active-generation.v2",
                "generation_id":GENERATION,
                "previous_generation_id":null,
                "activated_at":NOW,
                "projection_mode":"running"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            self.graph_path().parent().unwrap().join("manifest.json"),
            json!({
                "schema":"butler.memory-generation.v2",
                "generation_id":GENERATION,
                "format":"v2",
                "state":"active",
                "embedding":null
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            self.root.join("butler.config.json"),
            json!({"personalization":{"profiling":{"extractorModel":"provider/model","extractorReasoningEffort":"high"}}}).to_string(),
        ).unwrap();
        let store = self.open_store().await;
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
                now: Some("2026-09-14T00:00:00.000Z".into()),
            })
            .await
            .unwrap();
        let request = store
            .append_user_message(message(
                "request",
                ConversationRole::User,
                request_origin,
                "2026-09-14T00:00:01.000Z",
                request_text,
            ))
            .await
            .unwrap();
        let assistant = store
            .append_assistant_message(message(
                "assistant",
                ConversationRole::Assistant,
                ConversationOriginKind::AssistantPublic,
                "2026-09-14T00:00:02.000Z",
                assistant_text,
            ))
            .await
            .unwrap();
        store
            .finalize_turn(FinalizeTurnInput {
                turn_id: "turn".into(),
                status: Some("complete".into()),
                completed_at: Some("2026-09-14T00:00:03.000Z".into()),
                outcome_capsule: Some(TurnOutcomeCapsuleInput {
                    id: Some("outcome".into()),
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    generation: 1.0,
                    outcome: TurnOutcomeKind::Delivered,
                    request_message_id: Some(request.message.id),
                    public_assistant_message_id: Some(assistant.message.id),
                    provider_id: None,
                    model_ref: None,
                    evidence_refs: Vec::new(),
                    unresolved_obligations: Vec::new(),
                    continuation: None,
                    safe_code: None,
                    created_at: Some("2026-09-14T00:00:03.000Z".into()),
                }),
            })
            .await
            .unwrap();
        store.close().await.unwrap();
    }
    async fn open_store(&self) -> AgentConversationStore {
        AgentConversationStore::open(ConversationStoreConfig {
            path: self.canonical_path(),
            identity_clock: self.clock.clone(),
            collation: Arc::new(Collation),
        })
        .await
        .unwrap()
    }
    fn input(&self, completion: &str) -> RegisterConversationSourceInput {
        self.input_generation(completion, 1.0)
    }

    fn input_turn(&self, completion: &str, turn_id: &str) -> RegisterConversationSourceInput {
        let mut input = self.input(completion);
        if let CognitionConversationSourceNotice::Turn { turn_id: id, .. } = &mut input.notice {
            *id = turn_id.into();
        }
        input
    }

    async fn additional_turn(&self, turn_id: &str, text: &str) {
        let store = self.open_store().await;
        store
            .begin_turn(BeginTurnInput {
                gateway: "app".into(),
                external_session_id: "external".into(),
                session_id: Some("session".into()),
                workspace_id: None,
                project_id: Some("project".into()),
                actor: "user".into(),
                request_id: Some(format!("request-{turn_id}")),
                turn_id: Some(turn_id.into()),
                now: Some("2026-09-14T00:00:08.000Z".into()),
            })
            .await
            .unwrap();
        let mut user = message(
            &format!("request-{turn_id}"),
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            "2026-09-14T00:00:09.000Z",
            text,
        );
        user.turn_id = Some(turn_id.into());
        let request = store.append_user_message(user).await.unwrap();
        let mut public = message(
            &format!("assistant-{turn_id}"),
            ConversationRole::Assistant,
            ConversationOriginKind::AssistantPublic,
            "2026-09-14T00:00:10.000Z",
            "Public answer",
        );
        public.turn_id = Some(turn_id.into());
        let assistant = store.append_assistant_message(public).await.unwrap();
        store
            .finalize_turn(FinalizeTurnInput {
                turn_id: turn_id.into(),
                status: Some("complete".into()),
                completed_at: Some("2026-09-14T00:00:11.000Z".into()),
                outcome_capsule: Some(TurnOutcomeCapsuleInput {
                    id: Some(format!("outcome-{turn_id}")),
                    session_id: "session".into(),
                    turn_id: turn_id.into(),
                    generation: 1.0,
                    outcome: TurnOutcomeKind::Delivered,
                    request_message_id: Some(request.message.id),
                    public_assistant_message_id: Some(assistant.message.id),
                    provider_id: None,
                    model_ref: None,
                    evidence_refs: vec![],
                    unresolved_obligations: vec![],
                    continuation: None,
                    safe_code: None,
                    created_at: Some("2026-09-14T00:00:11.000Z".into()),
                }),
            })
            .await
            .unwrap();
        store.close().await.unwrap();
    }

    fn input_generation(
        &self,
        completion: &str,
        outcome_generation: f64,
    ) -> RegisterConversationSourceInput {
        RegisterConversationSourceInput {
            data_root: self.root.clone(),
            target: MemoryGenerationTarget::Active {
                expected_generation: GENERATION.into(),
            },
            notice: CognitionConversationSourceNotice::Turn {
                session_id: "session".into(),
                turn_id: "turn".into(),
                outcome_generation,
                extraction_version: "v-test".into(),
            },
            completion_job_id: Some(completion.into()),
            cancellation: None,
            deadline_at_epoch_ms: None,
            wait_class: CognitionWaitClass::Background,
        }
    }

    async fn advance_turn(&self) {
        let store = self.open_store().await;
        let assistant = store
            .append_assistant_message(message(
                "assistant-2",
                ConversationRole::Assistant,
                ConversationOriginKind::AssistantPublic,
                "2026-09-14T00:00:05.000Z",
                "Updated public answer",
            ))
            .await
            .unwrap();
        store
            .finalize_turn(FinalizeTurnInput {
                turn_id: "turn".into(),
                status: Some("complete".into()),
                completed_at: Some("2026-09-14T00:00:06.000Z".into()),
                outcome_capsule: Some(TurnOutcomeCapsuleInput {
                    id: Some("outcome-2".into()),
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    generation: 2.0,
                    outcome: TurnOutcomeKind::Delivered,
                    request_message_id: Some("request".into()),
                    public_assistant_message_id: Some(assistant.message.id),
                    provider_id: None,
                    model_ref: None,
                    evidence_refs: Vec::new(),
                    unresolved_obligations: Vec::new(),
                    continuation: None,
                    safe_code: None,
                    created_at: Some("2026-09-14T00:00:06.000Z".into()),
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

fn service(coordinator: Arc<CognitionWriteCoordinator>) -> Arc<CognitionRegistrationService> {
    service_with_clock(coordinator, Arc::new(|| NOW.into()))
}

fn service_with_clock(
    coordinator: Arc<CognitionWriteCoordinator>,
    clock: Clock,
) -> Arc<CognitionRegistrationService> {
    Arc::new(CognitionRegistrationService::new(
        CognitionPathEnvironment::default(),
        coordinator,
        clock,
    ))
}

mod cases;
mod semantic;
