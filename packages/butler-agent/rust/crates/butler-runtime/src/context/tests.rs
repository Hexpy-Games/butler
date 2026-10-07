mod budget;
mod quality;

use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use serde_json::json;

use super::*;
use butler_core::locale::LocaleCollation;
use butler_models::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
};
use butler_turn::btcc::ContextAssembly;
use butler_turn::conversation::*;

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
    let with_tools = text_for_message(&value, butler_turn::conversation::ToolParts::Include);
    let without = text_for_message(&value, butler_turn::conversation::ToolParts::Exclude);
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

// test-category: race
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
    let mut old = append("old", "remember me", "event-old");
    old.parts = Some([
        (ConversationPartKind::Text, json!({"text":"remember me 한글 é 😀 \"quote\" \\ end"})),
        (ConversationPartKind::ToolCall, json!({"safeToolName":"\u{feff}","toolName":"search","arguments":"must-not-render"})),
        (ConversationPartKind::ToolResult, json!({"safeLabel":" ","ok":false,"private":"must-not-render"})),
        (ConversationPartKind::Text, json!({"text":"tail\u{85}"})),
    ].into_iter().map(|(kind, content_json)| MessagePartInput {
        kind, content_json, tool_call_id: Some("call-1".into()), parent_tool_call_id: None,
        provider_shape: None, status: None,
    }).collect());
    conversation.append_user_message(old).await.unwrap();
    conversation
        .append_user_message(append("current", "exclude me", "event-current"))
        .await
        .unwrap();
    conversation
        .finalize_turn(FinalizeTurnInput {
            turn_id: "turn".into(),
            status: None,
            completed_at: None,
            outcome_capsule: None,
        })
        .await
        .unwrap();
    let window = conversation
        .read_history_window("session", 16_000)
        .await
        .unwrap();
    let raw = conversation
        .read_prompt_material("session", Some(16_000.0))
        .await
        .unwrap();
    let options = PromptMaterialRenderOptions {
        max_tokens: 16_000.0,
        exclude_source_ref: Some("event-current".into()),
        exclude_turn_id: None,
        include_summaries: None,
        include_tools: None,
        current_request: None,
    };
    let main = compile_prompt_material_context_plan(&raw, &options)
        .unwrap()
        .rendered;
    let budget_material = conversation
        .read_history_budget_material("session", 16_000)
        .await
        .unwrap();
    let budget = compile_prompt_material_context_plan(&budget_material, &options)
        .unwrap()
        .rendered;
    assert_eq!(
        butler_core::json::stringify(&json!(main)).unwrap().len(),
        butler_core::json::stringify(&json!(budget)).unwrap().len(),
        "main budget geometry including Unicode and escapes"
    );
    let kept = compile_prompt_material_context_plan(&window.material, &options)
        .unwrap()
        .rendered;
    assert!(kept.contains("[tool_call:search:call-1]"));
    assert!(kept.contains("[tool_result:failed:call-1]"));
    assert!(!kept.contains("must-not-render"));
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let locale = Arc::new(LocaleCollation::new("en-US").unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.clone(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock::new()),
            catalog.clone(),
            locale,
            butler_models::models::provider_http_client().unwrap(),
            Arc::new(butler_core::configuration::ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let owner = ContextConversation::new(
        conversation.clone(),
        configuration,
        catalog,
        ContextBudgetEnvironment::default(),
    );
    let assemble = || {
        include_recent_context(
            &owner,
            RecentConversationInput {
                transport: "app",
                runtime_session_id: "runtime",
                model_ref: Some("google/gemini-3.5-flash"),
                event_id: Some("event-current"),
            },
            ContextAssembly::default(),
        )
    };
    let (a, b) = tokio::join!(assemble(), assemble());
    assert_eq!(
        a.unwrap(),
        b.unwrap(),
        "parallel assemblies must have identical bytes"
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
    assert!(!assembly.working_context[0].content.starts_with('{'));
    assert!(
        !assembly.working_context[0]
            .content
            .contains("mainBudgetProjection")
    );
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
