use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use serde_json::{Value, json};

use super::*;
use crate::conversation::{
    AgentConversationStore, AppendMessageInput, AppendToolPartInput, BeginTurnInput,
    ConversationIdentityClock, ConversationLocaleCollation, ConversationOriginKind,
    ConversationPartKind, ConversationProvenance, ConversationProviderShape, ConversationReadOrder,
    ConversationRole, ConversationStatus, ConversationStoreConfig, FinalizeTurnInput,
    MessagePartInput, ReadCognitionMessagesInput, TurnOutcomeCapsuleInput, TurnOutcomeKind,
};

struct Clock;

impl ConversationIdentityClock for Clock {
    fn id(&self, prefix: &'static str) -> String {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        format!("{prefix}_{}", NEXT.fetch_add(1, AtomicOrdering::Relaxed))
    }

    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
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
    path: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-conversation-source-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let path = root.join("runtime/conversation-store.sqlite");
        Self { root, path }
    }

    async fn open_store(&self) -> AgentConversationStore {
        AgentConversationStore::open(ConversationStoreConfig {
            path: self.path.clone(),
            identity_clock: Arc::new(Clock),
            collation: Arc::new(Collation),
        })
        .await
        .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn canonical_store_reader_matches_bun_scalars_and_rereads_fresh_parts() {
    let fixture = Fixture::new("canonical");
    let store = fixture.open_store().await;
    store.begin_turn(begin()).await.unwrap();
    store.append_user_message(message_input()).await.unwrap();
    store.close().await.unwrap();

    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    assert!(reader.read_message("absent").unwrap().is_none());
    assert_eq!(
        reader.read_recent_public_message_ids("cs_source").unwrap(),
        vec!["cm_source"]
    );
    let message = reader.read_message("cm_source").unwrap().unwrap();
    let page = reader
        .read_cognition_messages(&ReadCognitionMessagesInput {
            session_id: Some("cs_source".into()),
            roles: vec![ConversationRole::User],
            since: Some("2026-09-13T00:00:00.000Z".into()),
            limit: Some(1_000.0),
            offset: Some(0.0),
            include_compacted: true,
            order: Some(ConversationReadOrder::Asc),
        })
        .unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].message.id, "cm_source");
    let scalars = decode_message_scalars(&message);
    assert_eq!(scalar_for_part(&message.parts[1], "/03/text"), Some("same"));
    assert_eq!(scalar_for_part(&message.parts[1], "/+1/text"), None);
    for scalar in &scalars {
        assert!(std::ptr::eq(scalar.message, &raw const message));
        assert!(
            message
                .parts
                .iter()
                .any(|part| std::ptr::eq(part, scalar.part))
        );
    }
    let actual = Value::Array(
        scalars
            .iter()
            .map(|scalar| {
                json!({
                    "part_id": match scalar.part.part_index {
                        0 => "cp_text",
                        1 => "cp_content",
                        _ => "cp_attachment",
                    },
                    "part_index": scalar.part.part_index,
                    "pointer": scalar.pointer,
                    "text": scalar.text,
                    "hash": scalar.hash,
                })
            })
            .collect(),
    );
    let golden: Value = serde_json::from_str(include_str!("tests/fixtures/scalars.json")).unwrap();
    assert_eq!(actual, golden);

    assert!(
        reader
            .connection
            .as_ref()
            .unwrap()
            .execute("DELETE FROM conversation_parts", [])
            .is_err()
    );
    let writer = fixture.open_store().await;
    writer
        .append_tool_call(AppendToolPartInput {
            message_id: "cm_source".into(),
            content_json: json!({"name":"inspect"}),
            tool_call_id: "call-1".into(),
            parent_tool_call_id: None,
            provider_shape: Some(ConversationProviderShape::Generic),
            status: Some(ConversationStatus::Complete),
        })
        .await
        .unwrap();
    writer.close().await.unwrap();
    assert_eq!(
        reader
            .read_message("cm_source")
            .unwrap()
            .unwrap()
            .parts
            .len(),
        4
    );
    reader.close().unwrap();
    prove_exclusive_open(&fixture.path);

    let dropped = ConversationSourceReader::open(&fixture.path).unwrap();
    drop(dropped);
    prove_exclusive_open(&fixture.path);
}

#[tokio::test]
async fn missing_schema_and_malformed_json_are_distinct_from_absent_message() {
    let missing = Fixture::new("missing");
    let Err(error) = ConversationSourceReader::open(&missing.path) else {
        panic!("missing canonical database must fail")
    };
    assert_eq!(error.code, "conversation_source_unavailable");
    assert!(!missing.path.exists());

    let incomplete = Fixture::new("schema");
    std::fs::create_dir_all(incomplete.path.parent().unwrap()).unwrap();
    rusqlite::Connection::open(&incomplete.path).unwrap();
    let Err(error) = ConversationSourceReader::open(&incomplete.path) else {
        panic!("incomplete canonical schema must fail")
    };
    assert_eq!(error.code, "conversation_source_schema_unavailable");

    let malformed = Fixture::new("malformed");
    let store = malformed.open_store().await;
    store.begin_turn(begin()).await.unwrap();
    store.append_user_message(message_input()).await.unwrap();
    store.close().await.unwrap();
    let raw = rusqlite::Connection::open(&malformed.path).unwrap();
    raw.execute(
        "UPDATE conversation_parts SET content_json='{bad' WHERE message_id='cm_source'",
        [],
    )
    .unwrap();
    drop(raw);
    let reader = ConversationSourceReader::open(&malformed.path).unwrap();
    let error = reader.read_message("cm_source").unwrap_err();
    assert_eq!(error.code, "conversation_json_error");
}

#[tokio::test]
async fn recall_pages_read_canonical_writer_rows_and_preserve_json_errors() {
    let fixture = Fixture::new("recall-pages");
    let store = fixture.open_store().await;
    store.begin_turn(begin()).await.unwrap();
    store.append_user_message(message_input()).await.unwrap();
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_source".into(),
            status: Some("complete".into()),
            completed_at: None,
            outcome_capsule: Some(TurnOutcomeCapsuleInput {
                id: Some("co_source".into()),
                session_id: "cs_source".into(),
                turn_id: "ct_source".into(),
                generation: 1.0,
                outcome: TurnOutcomeKind::Delivered,
                request_message_id: Some("cm_source".into()),
                public_assistant_message_id: None,
                provider_id: None,
                model_ref: None,
                evidence_refs: vec![],
                unresolved_obligations: vec![],
                continuation: None,
                safe_code: None,
                created_at: None,
            }),
        })
        .await
        .unwrap();
    let mut recovered = message_input();
    recovered.turn_id = None;
    recovered.message_id = Some("cm_recovered".into());
    recovered.provenance = Some(ConversationProvenance::Recovered);
    recovered.status = Some(ConversationStatus::Complete);
    store.append_user_message(recovered).await.unwrap();
    store.close().await.unwrap();

    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    let outcomes = reader.read_recall_outcome_page(None, None).unwrap();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].id, "co_source");
    assert_eq!(outcomes[0].request_message_id.as_deref(), Some("cm_source"));
    assert!(
        reader
            .read_recall_outcome_page(Some("co_source"), Some(500))
            .unwrap()
            .is_empty()
    );
    let recovered = reader.read_recovered_source_page(None, Some(64)).unwrap();
    assert_eq!(
        recovered
            .iter()
            .map(|row| row.message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["cm_recovered"]
    );
    assert!(
        reader
            .read_recovered_source_page(Some("cm_recovered"), Some(500))
            .unwrap()
            .is_empty()
    );
    reader.close().unwrap();

    let db = rusqlite::Connection::open(&fixture.path).unwrap();
    db.execute(
        "UPDATE conversation_turn_outcomes SET evidence_refs_json='{bad' WHERE id='co_source'",
        [],
    )
    .unwrap();
    drop(db);
    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    assert_eq!(
        reader
            .read_recall_outcome_page(None, Some(1))
            .unwrap_err()
            .code,
        "conversation_json_error"
    );
    reader.close().unwrap();
}

fn begin() -> BeginTurnInput {
    BeginTurnInput {
        gateway: "app".into(),
        external_session_id: "runtime-source".into(),
        session_id: Some("cs_source".into()),
        workspace_id: None,
        project_id: None,
        actor: "user".into(),
        request_id: Some("request-source".into()),
        turn_id: Some("ct_source".into()),
        now: Some("2026-09-14T00:00:00.000Z".into()),
    }
}

fn message_input() -> AppendMessageInput {
    AppendMessageInput {
        session_id: "cs_source".into(),
        turn_id: Some("ct_source".into()),
        text: String::new(),
        message_id: Some("cm_source".into()),
        role: ConversationRole::User,
        status: None,
        visibility: None,
        provenance: None,
        source_gateway: Some("app".into()),
        source_ref: Some("request-source".into()),
        origin_kind: Some(ConversationOriginKind::UserInput),
        origin_ref: None,
        origin_reason: None,
        origin_version: None,
        origin_evidence: None,
        now: Some("2026-09-14T00:00:00.000Z".into()),
        parts: Some(vec![
            MessagePartInput {
                kind: ConversationPartKind::Text,
                content_json: json!({"text":"  keep \n"}),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: None,
            },
            MessagePartInput {
                kind: ConversationPartKind::MessageContent,
                content_json: json!([
                    {"text":"안녕🙂"}, {"type":"image"}, {"text":""},
                    {"text":"same"}, {"text":"same"}, {"text":" "}
                ]),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: None,
            },
            MessagePartInput {
                kind: ConversationPartKind::AttachmentRef,
                content_json: json!({"text":"ignored"}),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: None,
            },
        ]),
    }
}

fn prove_exclusive_open(path: &std::path::Path) {
    let connection = rusqlite::Connection::open(path).unwrap();
    connection
        .execute_batch("BEGIN EXCLUSIVE; ROLLBACK")
        .unwrap();
}
