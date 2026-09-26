use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};

use super::*;
use crate::btcc::storage::{BtccRepositories, BtccStorage, StorageError, TestStorageFixture};
use crate::btcc::{
    AccessMode, AttachmentKind, AttachmentRef, ControlResolution, ControlSource, ExecutionControls,
    ModelFallback, Peer, PeerKind, ReasoningEffort, Sender, SessionRole as BtccRole, TurnMessage,
    TurnRoute, TurnStore,
};
use crate::conversation::{
    AdmissionMetric, CompletionMetric, CompletionObservation, ConversationIdentityClock,
    ConversationLocaleCollation, ConversationObserverFuture, ConversationStoreConfig,
};
use crate::workspace::{
    OwnOptional, SessionBindingStoreConfig, SessionLifecycleState, SessionRole,
    UpsertSessionBinding, WorkspaceClock, WorkspaceResult, WorkspaceStorageProfile,
};

struct Identity {
    next_id: AtomicU64,
    admissions: AtomicU64,
}
impl ConversationIdentityClock for Identity {
    fn id(&self, prefix: &'static str) -> String {
        format!(
            "{prefix}_{}",
            self.next_id.fetch_add(1, AtomicOrdering::Relaxed)
        )
    }
    fn now_iso(&self) -> String {
        "2026-09-14T00:00:00.000Z".into()
    }
}
impl WorkspaceClock for Identity {
    fn now_epoch_millis(&self) -> i64 {
        1_757_808_000_000
    }
    fn parse_iso_millis(&self, _: &str) -> Option<i64> {
        Some(1_757_808_000_000)
    }
    fn iso_from_epoch_millis(&self, _: i64) -> WorkspaceResult<String> {
        Ok("2026-09-14T00:00:00.000Z".into())
    }
}
impl ConversationLocaleCollation for Identity {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}
impl ConversationAdmissionObserver for Identity {
    fn admission_metric(&self, _: AdmissionMetric) -> ConversationObserverFuture<'_> {
        self.admissions.fetch_add(1, AtomicOrdering::Relaxed);
        Box::pin(async { Ok(()) })
    }
    fn completion_observation(&self, _: CompletionObservation) -> ConversationObserverFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn completion_metric(&self, _: CompletionMetric) -> ConversationObserverFuture<'_> {
        Box::pin(async { Ok(()) })
    }
}

struct ContextFixture {
    calls: AtomicU64,
    section: Mutex<String>,
}
impl ContextFixture {
    fn assembly(&self) -> ContextAssembly {
        ContextAssembly {
            live_configuration: vec![ContextSection {
                id: "eol".into(),
                title: "EOL".into(),
                content: self.section.lock().unwrap().clone(),
                region: Some("live_configuration".into()),
                projection_class: "profile".into(),
                scope_kind: "user".into(),
                source: None,
            }],
            ..ContextAssembly::default()
        }
    }
}
impl AdmissionContextPort for ContextFixture {
    fn build_butler<'a>(
        &'a self,
        _: &'a TurnRequest,
        _: &'a StoredSessionBinding,
    ) -> PortFuture<'a, ContextAssembly> {
        self.calls.fetch_add(1, AtomicOrdering::Relaxed);
        Box::pin(async { Ok(self.assembly()) })
    }
    fn build_steward<'a>(
        &'a self,
        _: &'a TurnRequest,
        _: &'a StoredSessionBinding,
    ) -> PortFuture<'a, ContextAssembly> {
        self.calls.fetch_add(1, AtomicOrdering::Relaxed);
        Box::pin(async { Ok(self.assembly()) })
    }
    fn include_recent<'a>(
        &'a self,
        _: &'a TurnRequest,
        _: &'a StoredSessionBinding,
        assembly: ContextAssembly,
    ) -> PortFuture<'a, ContextAssembly> {
        Box::pin(async move { Ok(assembly) })
    }
}

struct ModelFixture {
    calls: AtomicU64,
    changed: Mutex<bool>,
}
impl AdmissionModelCatalogPort for ModelFixture {
    fn snapshot(&self, refs: Vec<String>) -> PortFuture<'_, AdmissionModelCatalogSnapshot> {
        self.calls.fetch_add(1, AtomicOrdering::Relaxed);
        let changed = *self.changed.lock().unwrap();
        Box::pin(async move {
            Ok(AdmissionModelCatalogSnapshot {
                retry_ceiling: Some(3.0),
                metadata: refs
                    .into_iter()
                    .map(|reference| {
                        let (provider, model) = reference.split_once('/').unwrap();
                        AdmissionModelMetadata {
                            requested_model_ref: reference.clone(),
                            provider_id: provider.into(),
                            provider_family_id: Some(provider.into()),
                            model_id: model.into(),
                            reasoning_efforts: vec![ReasoningEffort::Medium],
                            default_reasoning_effort: ReasoningEffort::Medium,
                            context_window_tokens: Some(if changed { 10.0 } else { 200_000.0 }),
                        }
                    })
                    .collect(),
            })
        })
    }
}

#[tokio::test]
async fn actual_sqlite_fresh_and_replay_skip_changed_context_and_catalog() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("preparation-owner"))
        .await
        .unwrap();
    let repositories = BtccRepositories::new(storage.clone(), None);
    let root = temp("prepare");
    let identity = Arc::new(Identity {
        next_id: AtomicU64::new(1),
        admissions: AtomicU64::new(0),
    });
    let workspace = SessionBindingStore::open(SessionBindingStoreConfig {
        path: root.join("session.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: identity.clone(),
    })
    .await
    .unwrap();
    workspace.upsert(binding()).await.unwrap();
    let mut coercion_binding = workspace
        .get_by_session_id("session-1")
        .await
        .unwrap()
        .unwrap();
    coercion_binding.metadata = Some(
        json!({
            "plan_mode":"enabled",
            "reasoning_effort":null,
            "accessMode":"full_access",
            "runtimePolicy":{"accessMode":null}
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let catalog = AdmissionModelCatalogSnapshot {
        retry_ceiling: Some(3.0),
        metadata: vec![AdmissionModelMetadata {
            requested_model_ref: "provider/model".into(),
            provider_id: "provider".into(),
            provider_family_id: None,
            model_id: "model".into(),
            reasoning_efforts: vec![ReasoningEffort::Medium],
            default_reasoning_effort: ReasoningEffort::Medium,
            context_window_tokens: Some(200_000.0),
        }],
    };
    let truthy = model::admit(&coercion_binding, None, &catalog).unwrap();
    assert_eq!(truthy["controls"]["planMode"], true);
    assert_eq!(truthy["controls"]["accessMode"], "full_access");
    assert_eq!(truthy["reasoningEffort"], "medium");
    coercion_binding
        .metadata
        .as_mut()
        .unwrap()
        .insert("plan_mode".into(), 0.into());
    assert_eq!(
        model::admit(&coercion_binding, None, &catalog).unwrap()["controls"]["planMode"],
        false
    );
    let conversation = AgentConversationStore::open(ConversationStoreConfig {
        path: root.join("conversation.sqlite"),
        identity_clock: identity.clone(),
        collation: identity.clone(),
    })
    .await
    .unwrap();
    let context = Arc::new(ContextFixture {
        calls: AtomicU64::new(0),
        section: Mutex::new("Exact EOL".into()),
    });
    let models = Arc::new(ModelFixture {
        calls: AtomicU64::new(0),
        changed: Mutex::new(false),
    });
    let preparation = DefaultTurnPreparation::new(
        workspace.clone(),
        conversation.clone(),
        repositories.clone(),
        identity.clone(),
        context.clone(),
        models.clone(),
    );
    let request = request();
    let first = preparation.prepare(request.clone()).await.unwrap();
    assert!(first.turn.is_fresh);
    assert_eq!(first.turn.command["kind"], "run");
    assert_eq!(
        first.turn.command["context"]["messageContent"],
        json!([{"type":"text","text":"hello"}])
    );
    assert_eq!(
        first.turn.command["modelSelection"]["modelRoute"]["routeDigest"],
        "90182b3cf33aa888f4d42b624e22d8e3b61fd5796a72feda43614fdf1e68f181"
    );
    assert_eq!(
        first.turn.admission_input_hash,
        "b4b0894247db82eb687e44d60deb9acd130348b2b9d84f65553b9fb48a15f3d7"
    );
    repositories.load_or_admit(&first.turn).await.unwrap();
    drop(first);

    let mut changed_identity = request.clone();
    changed_identity.message.content = "changed".into();
    let error = preparation.prepare(changed_identity).await.err().unwrap();
    assert_eq!(error.code, "turn_replay_conflict");
    assert_eq!(identity.admissions.load(AtomicOrdering::Relaxed), 1);

    let stored = repositories.find_turn("turn-1").await.unwrap().unwrap();
    request::assert_replay_identity(&stored, &request).unwrap();

    let mut stored_null = repositories.find_turn("turn-1").await.unwrap().unwrap();
    stored_null
        .context
        .as_object_mut()
        .unwrap()
        .insert("messageContent".into(), Value::Null);
    let mut absent_content = request.clone();
    absent_content.app_turn_context = Some(json!({"session":{"id":"app-session"}}));
    assert_eq!(
        request::assert_replay_identity(&stored_null, &absent_content)
            .unwrap_err()
            .code,
        "turn_replay_conflict"
    );

    let mut wrong_role = request.clone();
    wrong_role.turn_id = "turn-role".into();
    wrong_role.event_id = "event-role".into();
    wrong_role.route.role = BtccRole::Steward;
    assert_eq!(
        preparation.prepare(wrong_role).await.err().unwrap().code,
        "session_binding_role_mismatch"
    );
    assert_eq!(context.calls.load(AtomicOrdering::Relaxed), 1);

    storage
        .execute(|db| {
            db.execute(
                "INSERT INTO btcc_wake_authorizations \
                 (source_turn_id, authorization_ref, result_scope_ref, created_at) \
                 VALUES (?1, ?2, ?3, 'fixture')",
                rusqlite::params!["source-turn", "authority-ref", "scope-ref"],
            )
            .map(|_| ())
            .map_err(|error| StorageError {
                code: "sqlite_error",
                message: error.to_string(),
            })
        })
        .await
        .unwrap();
    let mut wake = request.clone();
    wake.turn_id = "turn-wake".into();
    wake.event_id = "event-wake".into();
    wake.trigger = TurnTrigger::AuthorizedWake {
        trigger_id: "trigger-wake".into(),
        source_turn_id: "source-turn".into(),
        authorization_ref: "authority-ref".into(),
        result_scope_ref: Some("wrong-scope".into()),
    };
    assert_eq!(
        preparation.prepare(wake.clone()).await.err().unwrap().code,
        "wake_authorization_denied"
    );
    assert_eq!(context.calls.load(AtomicOrdering::Relaxed), 1);
    if let TurnTrigger::AuthorizedWake {
        result_scope_ref, ..
    } = &mut wake.trigger
    {
        *result_scope_ref = Some("scope-ref".into());
    }
    let wake = preparation.prepare(wake).await.unwrap();
    assert_eq!(wake.turn.command["kind"], "wake");
    let scopes = wake.turn.command["context"]["baselineObservationScopeRefs"]
        .as_array()
        .unwrap();
    assert_eq!(scopes.last(), Some(&json!("scope-ref")));
    assert_eq!(
        scopes
            .iter()
            .filter(|scope| scope.as_str() == Some("scope-ref"))
            .count(),
        1
    );
    drop(wake);

    workspace.upsert(subsession_binding()).await.unwrap();
    let mut subsession_request = request.clone();
    subsession_request.turn_id = "turn-subsession".into();
    subsession_request.event_id = "event-subsession".into();
    subsession_request.session_id = "session-subsession".into();
    subsession_request.route.role = BtccRole::Steward;
    subsession_request.execution_controls = Some(
        ExecutionControls::create(
            "turn-subsession",
            "session-subsession",
            ControlResolution {
                model: "provider/model".into(),
                reasoning_effort: ReasoningEffort::High,
                access_mode: AccessMode::FullAccess,
                plan_mode: true,
                source: ControlSource::MessageOverride,
                session_control_revision: 3,
                catalog_generation: " catalog-1 ".into(),
                model_fallback: Some(ModelFallback {
                    enabled: true,
                    models: vec![" backup/model ".into()],
                }),
                subsession_result: None,
            },
            "2026-09-14T00:00:00.000Z",
        )
        .unwrap(),
    );
    subsession_request.message.attachments = vec![
        AttachmentRef {
            id: "image".into(),
            kind: AttachmentKind::Image,
            mime_type: Some("image/png".into()),
            file_name: None,
            size_bytes: Some(-4.5),
            url: None,
            local_path: Some("/private/image.png".into()),
            visual_manifest: None,
        },
        AttachmentRef {
            id: "text".into(),
            kind: AttachmentKind::Document,
            mime_type: Some("text/plain".into()),
            file_name: Some("note.txt".into()),
            size_bytes: Some(8.25),
            url: None,
            local_path: Some("/workspace/note.txt".into()),
            visual_manifest: None,
        },
        AttachmentRef {
            id: "non-finite".into(),
            kind: AttachmentKind::Binary,
            mime_type: None,
            file_name: None,
            size_bytes: Some(f64::NAN),
            url: None,
            local_path: None,
            visual_manifest: None,
        },
    ];
    subsession_request.app_turn_context = Some(json!({
        "session":{"id":"app-subsession"},
        "projectSources":[{"id":"source"}],
        "sessionReferences":[{"id":"prior"}]
    }));
    let subsession = preparation.prepare(subsession_request).await.unwrap();
    let subsession_context = &subsession.turn.command["context"];
    assert_eq!(subsession_context["userRef"], "steward-role");
    assert_eq!(
        subsession_context["baselineObservationScopeRefs"],
        json!([])
    );
    assert_eq!(
        subsession_context["recentFeedbackRefs"],
        json!(["feedback"])
    );
    assert_eq!(
        subsession_context["mandatoryHotCacheRefs"],
        json!(["mandatory"])
    );
    assert!(
        subsession_context["attachments"][0]
            .get("localPath")
            .is_none()
    );
    assert_eq!(subsession_context["attachments"][0]["sizeBytes"], -4.5);
    assert_eq!(
        subsession_context["attachments"][1]["localPath"],
        "/workspace/note.txt"
    );
    assert_eq!(subsession_context["attachments"][1]["sizeBytes"], 8.25);
    assert!(
        subsession_context["attachments"][2]
            .get("sizeBytes")
            .is_none()
    );
    assert_eq!(
        subsession_context["executionPolicy"]["requiredNativeTools"],
        json!(["read_project_source", "read_conversation_session"])
    );
    assert_eq!(
        subsession_context["executionPolicy"]["accessMode"],
        "full_access"
    );
    assert_eq!(
        subsession.turn.command["modelSelection"]["modelRoute"]["candidates"][1]["modelRef"],
        "backup/model"
    );
    assert_eq!(
        subsession.turn.command["modelSelection"]["modelRoute"]["catalogGeneration"],
        "catalog-1"
    );
    drop(subsession);

    workspace.delete_session("session-1").await.unwrap();
    *context.section.lock().unwrap() = "changed".into();
    *models.changed.lock().unwrap() = true;
    let replay = preparation.prepare(request).await.unwrap();
    assert!(!replay.turn.is_fresh);
    assert_eq!(replay.turn.command["kind"], "resume");
    assert_eq!(context.calls.load(AtomicOrdering::Relaxed), 3);
    assert_eq!(models.calls.load(AtomicOrdering::Relaxed), 3);
    drop(replay);
    conversation.close().await.unwrap();
    workspace.close().await.unwrap();
    repositories.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

mod contracts;
mod fixtures;

use fixtures::*;
