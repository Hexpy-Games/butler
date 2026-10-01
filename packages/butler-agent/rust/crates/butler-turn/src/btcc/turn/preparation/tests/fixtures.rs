use super::*;

pub(super) fn binding() -> UpsertSessionBinding {
    UpsertSessionBinding {
        session_id: "session-1".into(),
        role: SessionRole::Butler,
        project_id: Some("project-1".into()),
        app_project_id: OwnOptional::Absent,
        ledger_project_id: OwnOptional::Absent,
        workspace_path: "/workspace".into(),
        runtime_adapter_id: "runtime".into(),
        model_provider_id: "provider".into(),
        model_ref: "provider/model".into(),
        runtime_session_ref: None,
        provider_thread_ref: None,
        transport_bindings: Vec::new(),
        lifecycle_state: Some(SessionLifecycleState::Active),
        created_at: None,
        updated_at: None,
        last_active_at: None,
        metadata: Some(Map::new()),
    }
}

pub(super) fn subsession_binding() -> UpsertSessionBinding {
    let mut value = binding();
    value.session_id = "session-subsession".into();
    value.role = SessionRole::Steward;
    value.metadata = Some(
        json!({"subsession":{
            "relation_id":"relation", "delegation_id":"delegation", "task_id":"task",
            "execution_mode":"read_only",
            "allowed_tools_and_effects":[
                "grep_files:workspace", "list_files:workspace", "read_file:workspace",
                "web_read:network", "web_search:network"
            ],
            "recent_feedback_refs":["feedback"],
            "project_context":{
                "project_id":"sub-project",
                "mandatory_hot_cache_refs":["mandatory"],
                "optional_hot_cache_refs":["optional"]
            }
        }})
        .as_object()
        .unwrap()
        .clone(),
    );
    value
}

pub(super) fn request() -> TurnRequest {
    TurnRequest {
        turn_id: "turn-1".into(),
        recovery_attempt: None,
        session_id: "session-1".into(),
        event_id: "event-1".into(),
        transport: "app".into(),
        account_id: "local".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "chat".into(),
            parent_id: None,
        },
        sender: Sender {
            id: "user".into(),
            display_name: None,
        },
        message: TurnMessage {
            id: "message-1".into(),
            content: "hello".into(),
            timestamp: "2026-09-14T00:00:00.000Z".into(),
            attachments: Vec::new(),
            image_admission: None,
        },
        trigger: TurnTrigger::UserMessage,
        route: TurnRoute {
            role: BtccRole::Butler,
            workspace_path: "/workspace".into(),
            project_id: Some("project-1".into()),
            reason: None,
        },
        progress_destination: None,
        execution_controls: None,
        empty_response_policy: None,
        app_turn_context: Some(
            json!({"session":{"id":"app-session"},"contentParts":[{"text":"hello","type":"text"}]}),
        ),
        authority_request_ref: None,
        authority_client_message_id: None,
        app_queue_claim_id: Some("claim".into()),
        resume: false,
        preparation_cancellation: Default::default(),
    }
}

/// The steward subsession turn built from `request`, with attachments and App context.
pub(super) fn subsession_request(request: &TurnRequest) -> TurnRequest {
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
    subsession_request
}

pub(super) fn temp(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed)
    ))
}
