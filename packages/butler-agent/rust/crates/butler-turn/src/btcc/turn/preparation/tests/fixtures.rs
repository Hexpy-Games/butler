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
        preparation_cancellation: Default::default(),
    }
}

pub(super) fn temp(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed)
    ))
}
