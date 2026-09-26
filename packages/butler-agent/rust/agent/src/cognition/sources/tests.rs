use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use serde_json::{Value, json};

use super::identity::recovered_parts_hash;
use super::*;
use crate::conversation::{
    AgentConversationStore, AppendMessageInput, BeginTurnInput, ConversationIdentityClock,
    ConversationLocaleCollation, ConversationOriginKind, ConversationPartKind,
    ConversationProvenance, ConversationRole, ConversationSourceReader, ConversationStatus,
    ConversationStoreConfig, FinalizeTurnInput, MessagePartInput, TurnOutcomeCapsuleInput,
    TurnOutcomeKind,
};

struct Clock(AtomicU64);

impl ConversationIdentityClock for Clock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", self.0.fetch_add(1, AtomicOrdering::Relaxed))
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

pub(super) struct Fixture {
    pub(super) root: PathBuf,
    pub(super) path: PathBuf,
}

impl Fixture {
    pub(super) fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "butler-cognition-source-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let path = root.join("runtime/conversation-store.sqlite");
        Self { root, path }
    }

    pub(super) async fn open(&self) -> AgentConversationStore {
        AgentConversationStore::open(ConversationStoreConfig {
            path: self.path.clone(),
            identity_clock: Arc::new(Clock(AtomicU64::new(1))),
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
async fn canonical_writer_turn_prepares_ordered_windows_hydration_and_prior_context() {
    let fixture = Fixture::new("turn");
    let store = fixture.open().await;
    store.begin_turn(begin()).await.unwrap();
    store
        .append_user_message(message(
            "cm_prior",
            None,
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            ConversationProvenance::Trusted,
            "2026-09-13T23:59:00.000Z",
            vec![
                part(ConversationPartKind::Text, json!({"text":"  prior one  "})),
                part(
                    ConversationPartKind::MessageContent,
                    json!([{"text":"ignored"}]),
                ),
                part(ConversationPartKind::Text, json!({"text":"prior two"})),
            ],
        ))
        .await
        .unwrap();
    let request = store
        .append_user_message(message(
            "cm_request",
            Some("ct_source"),
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            ConversationProvenance::Trusted,
            "2026-09-14T00:00:01.000Z",
            vec![part(
                ConversationPartKind::Text,
                json!({"text":format!("{}🙂", "a".repeat(8_192))}),
            )],
        ))
        .await
        .unwrap();
    let assistant = store
        .append_assistant_message(message(
            "cm_assistant",
            Some("ct_source"),
            ConversationRole::Assistant,
            ConversationOriginKind::AssistantPublic,
            ConversationProvenance::Trusted,
            "2026-09-14T00:00:02.000Z",
            vec![part(ConversationPartKind::Text, json!({"text":"answer"}))],
        ))
        .await
        .unwrap();
    store
        .append_user_message(message(
            "cm_prior_oversized",
            None,
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            ConversationProvenance::Trusted,
            "2026-09-13T23:59:30.000Z",
            vec![part(
                ConversationPartKind::Text,
                json!({"text":"z".repeat(5_000)}),
            )],
        ))
        .await
        .unwrap();
    store
        .append_user_message(message(
            "cm_prior_internal",
            None,
            ConversationRole::User,
            ConversationOriginKind::InternalControl,
            ConversationProvenance::Trusted,
            "2026-09-13T23:59:40.000Z",
            vec![part(
                ConversationPartKind::Text,
                json!({"text":"must not enter public context"}),
            )],
        ))
        .await
        .unwrap();
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_source".into(),
            status: Some("complete".into()),
            completed_at: Some("2026-09-14T00:00:03.000Z".into()),
            outcome_capsule: Some(TurnOutcomeCapsuleInput {
                id: Some("co_source".into()),
                session_id: "cs_source".into(),
                turn_id: "ct_source".into(),
                generation: 2.0,
                outcome: TurnOutcomeKind::Delivered,
                request_message_id: Some(request.message.id.clone()),
                public_assistant_message_id: Some(assistant.message.id.clone()),
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

    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    let PreparedConversationSource::Plan(plan) = prepare_conversation_source(
        &reader,
        ConversationSourceNotice::Turn {
            session_id: "cs_source",
            turn_id: "ct_source",
            outcome_generation: 2.0,
            extraction_version: "v-test",
        },
        "2026-09-14T00:00:04.000Z",
    )
    .unwrap() else {
        panic!("public turn must produce a plan")
    };
    assert_eq!(
        prepare_conversation_source(
            &reader,
            ConversationSourceNotice::Turn {
                session_id: "cs_source",
                turn_id: "ct_source",
                outcome_generation: 3.0,
                extraction_version: "v-test",
            },
            "2026-09-14T00:00:04.000Z",
        )
        .unwrap_err()
        .code,
        "memory_source_not_terminal"
    );
    assert_eq!(plan.rows.len(), 3);
    assert_eq!(plan.windows.len(), 3);
    assert!(plan.windows.iter().all(|window| window.len() == 1));
    assert_eq!(plan.rows[0].byte_start, 0.0);
    assert_eq!(plan.rows[0].byte_end, 8_192.0);
    assert_eq!(plan.rows[1].byte_start, 8_192.0);
    assert_eq!(plan.rows[1].byte_end, 8_196.0);
    assert_source_golden(&plan, "turn");
    let current = reader.read_message("cm_request").unwrap().unwrap();
    let hydrated = hydrate_conversation_source(&current, &plan.rows[1], 1.0).unwrap();
    assert_eq!(hydrated.text, "🙂");
    assert_eq!(hydrated.excerpt, "🙂");
    let mut invalid_boundary = plan.rows[1].clone();
    invalid_boundary.byte_start = 8_193.0;
    assert_eq!(
        hydrate_conversation_source(&current, &invalid_boundary, 1.0)
            .unwrap_err()
            .code,
        "memory_source_changed"
    );
    let context = read_prior_public_context(&reader, "cs_source", &plan.rows).unwrap();
    assert_eq!(context.len(), 1);
    assert_eq!(context[0].text, "prior one   prior two");
    assert!(
        crate::json::stringify(&serde_json::to_value(&context).unwrap())
            .unwrap()
            .contains("\"ref\":\"conversation-message:cm_prior\"")
    );
    let recall_input: crate::cognition::recall::RecallRequest = serde_json::from_value(json!({
        "cue":"answer","seedPhrases":[],"vectorQueries":[],"includeVector":false,
        "includeInternal":false,"limit":10,"scope":"all_user_sessions",
        "projectFilter":"any","projectIds":[],"sessionIds":[],
        "asOf":"2026-09-15T00:00:00.000Z","time":null,"cursor":null,
        "admittedChannels":null,
        "runtime":{"sessionId":"cs_source","turnId":"ct_source","currentUserMessage":"cm_request",
            "nativeOperationId":"op","projectId":null}
    }))
    .unwrap();
    let inventory = read_canonical_inventory(
        Some(&reader),
        &recall_input,
        i64::MAX,
        &|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map_or(f64::NAN, |date| date.timestamp_millis() as f64)
        },
        &str::cmp,
        || 0,
    )
    .unwrap();
    assert!(inventory.available && !inventory.partial);
    let entry = inventory
        .entries
        .iter()
        .find(|entry| entry.episode_id == plan.episode_id)
        .unwrap();
    assert_eq!(entry.revision, plan.revision);
    let mut expected_source_ids = plan
        .rows
        .iter()
        .map(|row| row.source_id.clone())
        .collect::<Vec<_>>();
    expected_source_ids.sort();
    assert_eq!(entry.source_ids, expected_source_ids);
    reader.close().unwrap();
}

#[tokio::test]
async fn canonical_writer_standalone_preserves_part_order_and_rejects_changed_hash() {
    let fixture = Fixture::new("standalone");
    let store = fixture.open().await;
    store.begin_turn(begin()).await.unwrap();
    let written = store
        .append_user_message(message(
            "cm_recovered",
            None,
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            ConversationProvenance::Imported,
            "2026-09-14T00:00:04.000Z",
            vec![
                part(ConversationPartKind::Text, json!({"text":"first"})),
                part(
                    ConversationPartKind::MessageContent,
                    json!([{"text":"둘"},{"text":"third"}]),
                ),
            ],
        ))
        .await
        .unwrap();
    let source_hash = recovered_parts_hash(&written).unwrap();
    let golden = source_golden();
    assert_eq!(source_hash, golden["standaloneSourceHash"]);
    store.close().await.unwrap();
    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    let PreparedConversationSource::Plan(plan) = prepare_conversation_source(
        &reader,
        ConversationSourceNotice::Standalone {
            session_id: "cs_source",
            message_id: "cm_recovered",
            source_hash: &source_hash,
            extraction_version: "v-test",
        },
        "2026-09-14T00:00:04.000Z",
    )
    .unwrap() else {
        panic!("imported standalone must produce a plan")
    };
    assert_eq!(
        plan.rows
            .iter()
            .map(|row| row.scalar_pointer.as_str())
            .collect::<Vec<_>>(),
        ["/text", "/0/text", "/1/text"]
    );
    assert_source_golden(&plan, "standalone");
    let mut leading_zero_pointer = plan.rows[1].clone();
    leading_zero_pointer.scalar_pointer = "/00/text".into();
    assert_eq!(
        hydrate_conversation_source(&written, &leading_zero_pointer, f64::INFINITY)
            .unwrap()
            .text,
        "둘"
    );
    let error = prepare_conversation_source(
        &reader,
        ConversationSourceNotice::Standalone {
            session_id: "cs_source",
            message_id: "cm_recovered",
            source_hash: "changed",
            extraction_version: "v-test",
        },
        "2026-09-14T00:00:04.000Z",
    )
    .unwrap_err();
    assert_eq!(error.code, "memory_source_changed");
}

#[tokio::test]
async fn failed_turn_replay_is_stable_and_generation_changes_revision_and_job() {
    let first = failed_turn_plan("failed-a", 1.0).await;
    let replay = failed_turn_plan("failed-b", 1.0).await;
    let next = failed_turn_plan("failed-c", 2.0).await;
    assert_eq!(first, replay);
    assert_ne!(first.revision, next.revision);
    assert_ne!(first.job_id, next.job_id);
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.rows[0].role, "user");
}

async fn failed_turn_plan(name: &str, generation: f64) -> CognitionSourcePlan {
    let fixture = Fixture::new(name);
    let store = fixture.open().await;
    store.begin_turn(begin()).await.unwrap();
    store
        .append_user_message(message(
            "cm_failed_request",
            Some("ct_source"),
            ConversationRole::User,
            ConversationOriginKind::UserInput,
            ConversationProvenance::Trusted,
            "2026-09-14T00:00:01.000Z",
            vec![part(
                ConversationPartKind::Text,
                json!({"text":"failed request"}),
            )],
        ))
        .await
        .unwrap();
    store
        .finalize_turn(FinalizeTurnInput {
            turn_id: "ct_source".into(),
            status: Some("failed".into()),
            completed_at: Some("2026-09-14T00:00:03.000Z".into()),
            outcome_capsule: Some(TurnOutcomeCapsuleInput {
                id: Some("co_failed".into()),
                session_id: "cs_source".into(),
                turn_id: "ct_source".into(),
                generation,
                outcome: TurnOutcomeKind::Failed,
                request_message_id: Some("cm_failed_request".into()),
                public_assistant_message_id: None,
                provider_id: None,
                model_ref: None,
                evidence_refs: Vec::new(),
                unresolved_obligations: Vec::new(),
                continuation: None,
                safe_code: Some("gateway_failed".into()),
                created_at: Some("2026-09-14T00:00:03.000Z".into()),
            }),
        })
        .await
        .unwrap();
    store.close().await.unwrap();
    let reader = ConversationSourceReader::open(&fixture.path).unwrap();
    let PreparedConversationSource::Plan(plan) = prepare_conversation_source(
        &reader,
        ConversationSourceNotice::Turn {
            session_id: "cs_source",
            turn_id: "ct_source",
            outcome_generation: generation,
            extraction_version: "v-test",
        },
        "2026-09-14T00:00:04.000Z",
    )
    .unwrap() else {
        panic!("failed terminal turn must produce a plan")
    };
    *plan
}

pub(super) fn begin() -> BeginTurnInput {
    BeginTurnInput {
        gateway: "app".into(),
        external_session_id: "source-session".into(),
        session_id: Some("cs_source".into()),
        workspace_id: None,
        project_id: None,
        actor: "user".into(),
        request_id: Some("request-source".into()),
        turn_id: Some("ct_source".into()),
        now: Some("2026-09-14T00:00:00.000Z".into()),
    }
}

pub(super) fn message(
    id: &str,
    turn_id: Option<&str>,
    role: ConversationRole,
    origin_kind: ConversationOriginKind,
    provenance: ConversationProvenance,
    now: &str,
    parts: Vec<MessagePartInput>,
) -> AppendMessageInput {
    AppendMessageInput {
        session_id: "cs_source".into(),
        turn_id: turn_id.map(str::to_owned),
        text: String::new(),
        message_id: Some(id.into()),
        role,
        status: Some(ConversationStatus::Complete),
        visibility: None,
        provenance: Some(provenance),
        source_gateway: Some("app".into()),
        source_ref: Some(id.into()),
        origin_kind: Some(origin_kind),
        origin_ref: None,
        origin_reason: None,
        origin_version: None,
        origin_evidence: None,
        now: Some(now.into()),
        parts: Some(parts),
    }
}

pub(super) fn part(kind: ConversationPartKind, content_json: Value) -> MessagePartInput {
    MessagePartInput {
        kind,
        content_json,
        tool_call_id: None,
        parent_tool_call_id: None,
        provider_shape: None,
        status: None,
    }
}

fn source_golden() -> Value {
    serde_json::from_str(include_str!("tests/fixtures/bun-source.json")).unwrap()
}

fn assert_source_golden(plan: &CognitionSourcePlan, key: &str) {
    let fixture = source_golden();
    let expected = &fixture[key];
    assert_eq!(plan.episode_id, expected["episodeId"]);
    assert_eq!(plan.revision, expected["revision"]);
    assert_eq!(plan.job_id, expected["jobId"]);
    assert_eq!(
        plan.rows
            .iter()
            .map(|row| row.source_id.as_str())
            .collect::<Vec<_>>(),
        expected["sourceIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(Value::as_str)
            .collect::<Option<Vec<_>>>()
            .unwrap()
    );
}
