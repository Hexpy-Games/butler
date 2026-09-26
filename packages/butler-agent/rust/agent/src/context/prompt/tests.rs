use std::cmp::Ordering;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::btcc::{
    AttachmentKind, AttachmentRef, Peer, PeerKind, Sender, SessionRole, TurnMessage, TurnRequest,
    TurnRoute, TurnTrigger,
};
use crate::context::{ContextBudgetEnvironment, ContextConversation, ContextError};
use crate::conversation::*;
use crate::locale::LocaleCollation;
use crate::models::{
    ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
};
use crate::workspace::{SessionLifecycleState, SessionRole as WorkspaceRole, StoredSessionBinding};

mod integration;
mod support;
mod unit;
use support::{ids, temp};

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
impl PromptClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        1_789_344_000_000
    }
    fn parse_timestamp(&self, value: &str) -> Option<i64> {
        (value == "2026-09-14T00:00:00.000Z").then_some(1_789_344_000_000)
    }
    fn iso_from_epoch_millis(&self, value: i64) -> ContextResult<String> {
        (value == 1_789_344_000_000)
            .then(|| "2026-09-14T00:00:00.000Z".into())
            .ok_or_else(|| ContextError::new("clock_range", "invalid timestamp"))
    }
    fn format_local_time(&self, _: i64, timezone: &str) -> ContextResult<String> {
        if timezone == "UTC" {
            Ok("Monday, September 14, 2026 at 12:00:00 AM UTC".into())
        } else {
            Err(ContextError::new("timezone", "invalid timezone"))
        }
    }
}
struct Collation;
impl ConversationLocaleCollation for Collation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

struct Profile {
    calls: Arc<Mutex<Vec<String>>>,
    rich: bool,
}
impl ProfilePromptPort for Profile {
    fn naming_profile<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.calls.lock().unwrap().push("naming".into());
        Box::pin(async {
            Ok(Some("# Personalization Profile\n\n- Butler nickname: Bee\n- Principal name: Alex\n- Address the principal as: Captain\n\nUse these naming preferences naturally. Do not force the address into every message.".into()))
        })
    }
    fn runtime_profile<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.calls.lock().unwrap().push("runtime".into());
        let value = self.rich.then(|| "runtime profile".into());
        Box::pin(async move { Ok(value) })
    }
    fn first_chat_onboarding<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
        locale: &'a str,
    ) -> ContextFuture<'a, Option<String>> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("onboarding:{locale}"));
        let value = self.rich.then(|| "onboarding".into());
        Box::pin(async move { Ok(value) })
    }
}

struct Cognition {
    calls: Arc<Mutex<Vec<String>>>,
    rich: bool,
}
impl CognitionPromptPort for Cognition {
    fn scoped_feedback<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Vec<ScopedFeedbackProjection>> {
        self.calls.lock().unwrap().push("feedback".into());
        let value = self.rich.then(|| ScopedFeedbackProjection {
            scope_kind: "user".into(),
            content: "feedback".into(),
        });
        Box::pin(async move { Ok(value.into_iter().collect()) })
    }
    fn generation_hot_cache<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.calls.lock().unwrap().push("hot".into());
        let value = self.rich.then(|| "hot cache".into());
        Box::pin(async move { Ok(value) })
    }
    fn session_continuity<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.calls.lock().unwrap().push("continuity".into());
        Box::pin(async { Ok(Some("session continuity".into())) })
    }
    fn project_capsule<'a>(
        &'a self,
        _: &'a PromptProjectionInput<'a>,
    ) -> ContextFuture<'a, Option<String>> {
        self.calls.lock().unwrap().push("project".into());
        Box::pin(async { Ok(Some("project memory\nkept".into())) })
    }
    fn project_capsule_status<'a>(
        &'a self,
        _: &'a StoredSessionBinding,
        _: &'a tokio_util::sync::CancellationToken,
    ) -> ContextFuture<'a, ProjectCapsuleStatus> {
        Box::pin(async { Ok(ProjectCapsuleStatus::Present) })
    }
}

#[tokio::test]
async fn butler_and_steward_assemblies_keep_sections_producer_order_and_fallbacks() {
    let root = temp("golden");
    let (mut assembler, conversation, profile_calls, cognition_calls) = fixture(&root, false).await;
    let butler_binding = binding(WorkspaceRole::Butler);
    let request = request();
    let steward_binding = binding(WorkspaceRole::Steward);
    let assembly = assembler
        .build_butler_context_assembly(&request, &butler_binding)
        .await
        .unwrap();
    assert_eq!(
        ids(&assembly.live_configuration),
        [
            "eol",
            "rules",
            "active-persona-reminder",
            "personalization-profile"
        ]
    );
    assert_eq!(
        ids(&assembly.retrieved_context),
        ["session-continuity", "project-memory"]
    );
    assert_eq!(
        assembly.working_context[0].content,
        "- pic.png (image, image/png, 4.5 bytes, attachment_id: a1)"
    );
    assert_eq!(assembly.current_input[0].content, "Message Text: hello");
    assert_eq!(
        assembly.references,
        vec![
            json!({"kind":"attachment","id":"a1","label":" pic.png ","metadata":{"kind":"image","mimeType":" image/png ","sizeBytes":4.5}})
        ]
    );
    assert!(
        assembly.runtime_state[0]
            .content
            .contains("Assistant Response Language: ko")
    );
    assert_eq!(
        *profile_calls.lock().unwrap(),
        ["naming", "onboarding:ko", "runtime"]
    );
    assert_eq!(
        *cognition_calls.lock().unwrap(),
        ["feedback", "project", "hot", "continuity"]
    );
    let steward = assembler
        .build_steward_context_assembly(&request, &steward_binding)
        .await
        .unwrap();
    assert_ne!(steward.live_config_hash, assembly.live_config_hash);
    assert_eq!(ids(&steward.static_context), ["runtime-system-contract"]);
    assert!(steward.working_context.is_empty() && steward.current_input.is_empty());
    std::fs::remove_file(root.join("data/eol.md")).unwrap();
    let fallback = assembler
        .build_butler_context_assembly(&request, &butler_binding)
        .await
        .unwrap();
    assert_eq!(fallback.live_configuration[0].content, "bundled ethos");
    assembler.environment.response_language = None;
    std::fs::write(
        root.join("data/butler.config.json"),
        r#"{"user":{"timezone":"Invalid/Zone","responseLanguage":"English"}}"#,
    )
    .unwrap();
    let mut invalid_time_request = request.clone();
    invalid_time_request.message.timestamp = "invalid".into();
    let changed = assembler
        .build_butler_context_assembly(&invalid_time_request, &butler_binding)
        .await
        .unwrap();
    assert!(
        changed.runtime_state[0]
            .content
            .contains("Assistant Response Language: en")
    );
    assert!(
        changed.runtime_state[0]
            .content
            .contains("Current Local Time: 2026-09-14T00:00:00.000Z")
    );
    std::fs::remove_file(root.join("data/butler.config.json")).unwrap();
    std::fs::create_dir(root.join("data/butler.config.json")).unwrap();
    assert_eq!(
        assembler
            .build_butler_context_assembly(&request, &butler_binding)
            .await
            .unwrap_err()
            .code,
        "prompt_file_read_error"
    );
    conversation.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

pub(super) async fn fixture(
    root: &Path,
    rich: bool,
) -> (
    PromptAssembler,
    AgentConversationStore,
    Arc<Mutex<Vec<String>>>,
    Arc<Mutex<Vec<String>>>,
) {
    write_fixture(root);
    let conversation = AgentConversationStore::open(ConversationStoreConfig {
        path: root.join("conversation.sqlite"),
        identity_clock: Arc::new(Clock::new()),
        collation: Arc::new(Collation),
    })
    .await
    .unwrap();
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.to_path_buf(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock::new()),
            catalog.clone(),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            crate::models::provider_http_client().unwrap(),
            Arc::new(crate::configuration::ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let profile_calls = Arc::new(Mutex::new(Vec::new()));
    let cognition_calls = Arc::new(Mutex::new(Vec::new()));
    let assembler = PromptAssembler::new(
        PromptPaths {
            resource_root: root.join("resources"),
            data_root: root.join("data"),
            cognition_root: root.join("data/cognition/memory"),
        },
        PromptEnvironment {
            response_language_override: None,
            response_language: Some("ko".into()),
            user_geo: Some(" Seoul   KR ".into()),
        },
        PromptDependencies {
            profile: Arc::new(Profile {
                calls: profile_calls.clone(),
                rich,
            }),
            cognition: Arc::new(Cognition {
                calls: cognition_calls.clone(),
                rich,
            }),
            clock: Arc::new(Clock::new()),
        },
        ContextConversation::new(
            conversation.clone(),
            configuration,
            catalog,
            ContextBudgetEnvironment::default(),
        ),
    );
    (assembler, conversation, profile_calls, cognition_calls)
}

fn write_fixture(root: &Path) {
    let resources = root.join("resources");
    for path in [
        resources.join("prompts"),
        root.join("data/config"),
        root.join("data/personas"),
        root.join("data/cognition/memory/rules"),
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    for (path, value) in [
        (
            resources.join("prompts/runtime-system-contract.md"),
            "runtime contract\n",
        ),
        (resources.join("prompts/butler.md"), "butler role\n"),
        (resources.join("prompts/steward.md"), "steward role\n"),
        (resources.join("eol.md"), "bundled ethos\n"),
        (root.join("data/eol.md"), "data ethos\n"),
        (root.join("data/config/steward.md"), "steward live config\n"),
        (
            root.join("data/personas/active.md"),
            "**Language:** Korean\nPersona body\n",
        ),
        (
            root.join("data/cognition/memory/rules/INDEX.md"),
            "- [One](one.md)\n- [Again](one.md)\n",
        ),
        (
            root.join("data/cognition/memory/rules/one.md"),
            "rule body\n",
        ),
    ] {
        std::fs::write(path, value).unwrap();
    }
    std::fs::write(root.join("butler.config.json"), "{}").unwrap();
    std::fs::write(root.join("data/butler.config.json"), r#"{"user":{"timezone":"UTC","language":"ko","responseLanguage":"en","techLanguage":"Rust","location":{"city":"Seoul","country":"KR"}}}"#).unwrap();
}

pub(super) fn binding(role: WorkspaceRole) -> StoredSessionBinding {
    StoredSessionBinding {
        session_id: "session-1".into(),
        role,
        lifecycle_state: SessionLifecycleState::Active,
        project_id: Some("proj".into()),
        app_project_id: None,
        ledger_project_id: None,
        workspace_path: "/workspace".into(),
        runtime_adapter_id: "native".into(),
        model_provider_id: "openai".into(),
        model_ref: "openai/gpt-5.5-codex".into(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: vec![],
        created_at: "now".into(),
        updated_at: "now".into(),
        last_active_at: None,
        metadata: None,
    }
}
pub(super) fn request() -> TurnRequest {
    TurnRequest {
        turn_id: "turn".into(),
        recovery_attempt: None,
        session_id: "session-1".into(),
        event_id: "event-1".into(),
        transport: "app".into(),
        account_id: "account".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "peer".into(),
            parent_id: None,
        },
        sender: Sender {
            id: "user".into(),
            display_name: None,
        },
        message: TurnMessage {
            id: "message".into(),
            content: "  hello  ".into(),
            timestamp: "2026-09-14T00:00:00.000Z".into(),
            attachments: vec![
                AttachmentRef {
                    id: "a1".into(),
                    kind: AttachmentKind::Image,
                    mime_type: Some(" image/png ".into()),
                    file_name: Some(" pic.png ".into()),
                    size_bytes: Some(4.5),
                    url: None,
                    local_path: None,
                    visual_manifest: None,
                },
                AttachmentRef {
                    id: String::new(),
                    kind: AttachmentKind::Binary,
                    mime_type: None,
                    file_name: None,
                    size_bytes: None,
                    url: None,
                    local_path: None,
                    visual_manifest: None,
                },
            ],
            image_admission: None,
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role: SessionRole::Butler,
            workspace_path: "/workspace".into(),
            project_id: Some("proj".into()),
            reason: None,
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: None,
        app_turn_context: None,
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: None,
        preparation_cancellation: tokio_util::sync::CancellationToken::new(),
    }
}
