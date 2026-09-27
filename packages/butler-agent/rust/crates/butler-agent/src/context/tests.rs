use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use serde_json::{Map, json};

use super::*;
use crate::btcc::ContextAssembly;
use crate::conversation::*;
use crate::locale::LocaleCollation;
use crate::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
};

struct Clock(AtomicU64);
impl Clock {
    fn new() -> Self {
        Self(AtomicU64::new(1))
    }
}
impl ConversationIdentityClock for Clock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", self.0.fetch_add(1, AtomicOrdering::Relaxed))
    }
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
}
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_789_344_000_000
    }
}
struct Collation;
impl ConversationLocaleCollation for Collation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

fn temp(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-context-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed)
    ))
}
async fn store(path: PathBuf) -> AgentConversationStore {
    AgentConversationStore::open(ConversationStoreConfig {
        path,
        identity_clock: Arc::new(Clock::new()),
        collation: Arc::new(Collation),
    })
    .await
    .unwrap()
}

fn message(
    id: &str,
    turn: Option<&str>,
    seq: u64,
    role: ConversationRole,
    text: &str,
) -> ConversationMessageWithParts {
    ConversationMessageWithParts {
        message: ConversationMessage {
            id: id.into(),
            session_id: "session".into(),
            turn_id: turn.map(str::to_owned),
            seq,
            role,
            status: ConversationStatus::Complete,
            visibility: ConversationVisibility::Model,
            provenance: ConversationProvenance::Trusted,
            created_at: "2026-09-14T00:00:00.000Z".into(),
            compacted_by_summary_id: None,
            source_gateway: Some("app".into()),
            source_ref: Some(format!("event-{seq}")),
            origin_kind: if role == ConversationRole::User {
                ConversationOriginKind::UserInput
            } else {
                ConversationOriginKind::AssistantPublic
            },
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence_json: None,
        },
        parts: vec![ConversationPart {
            id: format!("part-{id}"),
            message_id: id.into(),
            part_index: 0,
            kind: ConversationPartKind::Text,
            content_json: json!({"text":text}),
            tool_call_id: None,
            parent_tool_call_id: None,
            provider_shape: None,
            status: ConversationStatus::Complete,
        }],
    }
}

#[test]
fn compiler_preserves_required_turns_optional_stop_and_canonical_atoms() {
    let semantic_tail = (1..=10)
        .map(|index| {
            message(
                &format!("m{index}"),
                Some(&format!("t{index}")),
                index,
                if index % 2 == 0 {
                    ConversationRole::Assistant
                } else {
                    ConversationRole::User
                },
                &format!("text {index}"),
            )
        })
        .collect::<Vec<_>>();
    let turns = (1..=10)
        .map(|index| ConversationTurn {
            id: format!("t{index}"),
            session_id: "session".into(),
            seq: index,
            actor: "butler".into(),
            status: if index == 10 {
                "failed".into()
            } else {
                "complete".into()
            },
            request_id: None,
            started_at: "2026-09-14T00:00:00.000Z".into(),
            completed_at: None,
        })
        .collect();
    let material = PromptMaterial {
        session_id: "session".into(),
        summaries: vec![ConversationSummary {
            id: "summary".into(),
            session_id: "session".into(),
            covers_from_seq: 1.0,
            covers_to_seq: 2.0,
            source_hash: "sha256:summary".into(),
            model: None,
            summary_text: " old context ".into(),
            created_at: "2026-09-14T00:00:00.000Z".into(),
            invalidated_at: None,
        }],
        semantic_tail,
        current_turn: vec![],
        turns,
        outcomes: vec![],
        token_estimate: 0,
        provenance: vec![],
    };
    let plan = compile_prompt_material_context_plan(
        &material,
        &PromptMaterialRenderOptions {
            max_tokens: 1.0,
            exclude_source_ref: None,
            exclude_turn_id: None,
            include_summaries: None,
            include_tools: None,
            current_request: Some(CurrentRequestInput {
                id: "request".into(),
                text: "new input".into(),
            }),
        },
    )
    .unwrap();
    assert_eq!(
        plan.required_turns
            .iter()
            .map(|v| v.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"]
    );
    assert_eq!(
        plan.optional_turns
            .iter()
            .map(|v| v.turn_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["t2", "t1"]
    );
    assert!(plan.selected_optional_turns.is_empty());
    assert!(plan.selected_summaries.is_empty());
    assert_eq!(
        plan.selected_atom_ids.first().unwrap(),
        "current_request:request"
    );
    assert_eq!(plan.compiled_input_tokens, 344);
    assert_eq!(
        plan.required_turns[0].source_hash,
        "sha256:04b1b6853068a05d495bf11e7fb19c4cb0589c2fea0105a765cbbb0d4ed3afb1"
    );
    assert_eq!(
        plan.required_turns[7].source_hash,
        "sha256:cde97043cf9ac0a4894f2b26305e46dd408d87052c76783873f2c65de475563d"
    );
    assert!(
        plan.rendered
            .starts_with("## Recent Conversation\nturn t3 status complete")
    );
    assert!(
        plan.rendered
            .ends_with("user: text 9\nturn t10 status failed\nbutler: text 10")
    );
}

#[test]
fn compiler_validates_session_refs_and_bounds_tool_labels() {
    let mut value = message("m", None, 1, ConversationRole::User, "");
    value.parts = vec![
        ConversationPart {
            id: "ref".into(),
            message_id: "m".into(),
            part_index: 0,
            kind: ConversationPartKind::MessageContent,
            content_json: json!({"version":1,"parts":[{"type":"session_ref","sessionId":"prior","titleSnapshot":"Prior"}]}),
            tool_call_id: None,
            parent_tool_call_id: None,
            provider_shape: None,
            status: ConversationStatus::Complete,
        },
        ConversationPart {
            id: "call".into(),
            message_id: "m".into(),
            part_index: 1,
            kind: ConversationPartKind::ToolCall,
            content_json: json!({"safeToolName":"search"}),
            tool_call_id: Some("call-1".into()),
            parent_tool_call_id: None,
            provider_shape: None,
            status: ConversationStatus::Complete,
        },
        ConversationPart {
            id: "result".into(),
            message_id: "m".into(),
            part_index: 2,
            kind: ConversationPartKind::ToolResult,
            content_json: json!({"ok":false,"private":"must-not-render"}),
            tool_call_id: None,
            parent_tool_call_id: Some("call-1".into()),
            provider_shape: None,
            status: ConversationStatus::Failed,
        },
    ];
    let with_tools = text_for_message(&value, true);
    let without = text_for_message(&value, false);
    assert_eq!(
        with_tools,
        "[user session references: [{\"type\":\"session_ref\",\"sessionId\":\"prior\",\"titleSnapshot\":\"Prior\"}]] [tool_call:search:call-1] [tool_result:failed:call-1]"
    );
    assert_eq!(
        without,
        "[user session references: [{\"type\":\"session_ref\",\"sessionId\":\"prior\",\"titleSnapshot\":\"Prior\"}]]"
    );
    assert!(!with_tools.contains("must-not-render"));
}

#[tokio::test]
async fn real_store_read_compile_and_recent_use_one_bounded_owner() {
    let root = temp("real");
    let conversation = store(root.join("conversation.sqlite")).await;
    conversation
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "runtime".into(),
            session_id: Some("session".into()),
            workspace_id: None,
            project_id: None,
            actor: "user".into(),
            request_id: Some("event-old".into()),
            turn_id: Some("turn".into()),
            now: None,
        })
        .await
        .unwrap();
    let append = |id: &str, text: &str, source: &str| AppendMessageInput {
        session_id: "session".into(),
        turn_id: Some("turn".into()),
        text: text.into(),
        message_id: Some(id.into()),
        role: ConversationRole::User,
        status: None,
        visibility: None,
        provenance: None,
        source_gateway: Some("app".into()),
        source_ref: Some(source.into()),
        origin_kind: Some(ConversationOriginKind::UserInput),
        origin_ref: None,
        origin_reason: None,
        origin_version: None,
        origin_evidence: None,
        now: None,
        parts: None,
    };
    conversation
        .append_user_message(append("old", "remember me", "event-old"))
        .await
        .unwrap();
    conversation
        .append_user_message(append("current", "exclude me", "event-current"))
        .await
        .unwrap();
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let locale = Arc::new(LocaleCollation::new("en-US").unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.clone(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock::new()),
            catalog.clone(),
            locale,
            crate::models::provider_http_client().unwrap(),
            Arc::new(crate::configuration::ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let owner = ContextConversation::new(
        conversation.clone(),
        configuration,
        catalog,
        ContextBudgetEnvironment::default(),
    );
    let assembly = include_recent_context(
        &owner,
        RecentConversationInput {
            transport: "app",
            runtime_session_id: "runtime",
            model_ref: Some("google/gemini-3.5-flash"),
            event_id: Some("event-current"),
        },
        ContextAssembly::default(),
    )
    .await
    .unwrap();
    assert_eq!(assembly.working_context.len(), 1);
    assert!(assembly.working_context[0].content.contains("remember me"));
    assert!(!assembly.working_context[0].content.contains("exclude me"));
    let read = owner
        .read_conversation_context(ReadConversationContextInput {
            session_id: "runtime".into(),
            gateway: Some("app".into()),
            query: Some("remember".into()),
            anchor_message_id: None,
            anchor_event_id: None,
            direction: Some(ConversationContextDirection::Around),
            limit: Some(10.0),
            max_chars: Some(4000.0),
            include_tools: false,
            validated_limits: None,
            include_internal: false,
        })
        .await
        .unwrap();
    assert_eq!(read.session_id, "session");
    assert_eq!(read.messages[0].conversation_message_id, "old");
    let query = |value: &str| ReadConversationContextInput {
        session_id: "runtime".into(),
        gateway: Some("app".into()),
        query: Some(value.into()),
        anchor_message_id: None,
        anchor_event_id: None,
        direction: Some(ConversationContextDirection::Around),
        limit: Some(1.0),
        max_chars: Some(4000.0),
        include_tools: false,
        validated_limits: None,
        include_internal: false,
    };
    let bom_query = owner
        .read_conversation_context(query("nomatch\u{feff}remember"))
        .await
        .unwrap();
    assert_eq!(bom_query.messages[0].conversation_message_id, "old");
    let nel_query = owner
        .read_conversation_context(query("nomatch\u{85}remember"))
        .await
        .unwrap();
    assert_eq!(nel_query.messages[0].conversation_message_id, "current");
    conversation.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn budget_precedence_numeric_strings_metadata_and_thresholds_match_source() {
    let root = temp("budget");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("butler.config.json"),
        r#"{"system":{"contextWindowTokens":11111,"contextWindowTokensByModel":{"local/sample":12222},"contextReservedOutputTokens":1300,"contextReservedToolTokens":1400},"models":{"local":[{"model_id":"sample","server_url":"http://localhost:8000","context_window_tokens":15555}]}}"#,
    ).unwrap();
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let locale = Arc::new(LocaleCollation::new("en-US").unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.clone(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock::new()),
            catalog.clone(),
            locale,
            crate::models::provider_http_client().unwrap(),
            Arc::new(crate::configuration::ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let configured_owner = ContextBudgetOwner::new(
        configuration.clone(),
        catalog.clone(),
        ContextBudgetEnvironment::default(),
    );
    let configured = configured_owner.snapshot().await.unwrap();
    assert_eq!(
        configured
            .resolve(Some("local/sample"), &ContextBudgetOverrides::default())
            .context_window_tokens,
        12222.0
    );
    drop(configured);
    let owner = ContextBudgetOwner::new(
        configuration.clone(),
        catalog.clone(),
        ContextBudgetEnvironment {
            context_window_tokens: Some("0x4000".into()),
            reserved_output_tokens: Some("2048".into()),
            reserved_tool_tokens: None,
            compaction_prompt_reserve_tokens: Some("0o2000".into()),
        },
    );
    let snapshot = owner.snapshot().await.unwrap();
    let base = snapshot.resolve(Some("local/sample"), &ContextBudgetOverrides::default());
    assert_eq!(base.context_window_tokens, 16384.0); // environment precedes config/model metadata
    assert_eq!(base.reserved_output_tokens, 2048.0);
    assert_eq!(base.reserved_tool_tokens, 1400.0);
    let overrides = ContextBudgetOverrides {
        context_window_tokens: Some(json!(32768)),
        reserved_output_tokens: None,
        reserved_tool_tokens: None,
        model_windows: Some(Map::from_iter([("local/sample".into(), json!(24576))])),
    };
    assert_eq!(
        snapshot
            .resolve(Some("local/sample"), &overrides)
            .context_window_tokens,
        32768.0
    );
    let evaluation = snapshot.evaluate(Some("local/sample"), 22938.6, &overrides);
    assert_eq!(evaluation.input_tokens, 22938.0);
    assert_eq!(evaluation.threshold_state, ContextThresholdState::Warning);
    assert_eq!(evaluation.pressure_level, ContextPressureLevel::Medium);
    let compact = snapshot.evaluate(Some("local/sample"), 26215.0, &overrides);
    assert_eq!(compact.threshold_state, ContextThresholdState::AutoCompact);
    let hard = snapshot.evaluate(Some("local/sample"), 29492.0, &overrides);
    assert_eq!(hard.threshold_state, ContextThresholdState::HardPressure);
    let working = snapshot.evaluate_working(&WorkingContextBudgetInput {
        model_ref: Some("local/sample".into()),
        working_context_tokens: 20000.9,
        static_context_tokens: Some(10.9),
        live_configuration_tokens: Some(20.9),
        runtime_state_tokens: Some(30.9),
        compaction_prompt_reserve_tokens: None,
        overrides,
    });
    assert_eq!(working.compaction_prompt_reserve_tokens, 1024.0);
    assert!(working.usable_user_message_tokens > 0.0);
    assert_eq!(
        snapshot.default_recent_conversation_token_budget(Some("local/sample")),
        2000.0
    );
    drop(snapshot);
    std::fs::write(root.join("butler.config.json"),r#"{"models":{"local":[{"model_id":"sample","server_url":"http://localhost:8000","context_window_tokens":15555}]}}"#).unwrap();
    let metadata = configured_owner.snapshot().await.unwrap();
    assert_eq!(
        metadata
            .models
            .resolve_model_metadata(Some("local/sample"))
            .context_window_tokens,
        Some(15555.0)
    );
    assert_eq!(
        metadata
            .resolve(Some("local/sample"), &ContextBudgetOverrides::default())
            .context_window_tokens,
        15555.0
    );
    drop(metadata);
    let _ = std::fs::remove_dir_all(root);
}
