//! Security boundary (#237): a schedule's own access reaches its App turn as
//! a per-message override. The turn runs with it, but the session binding
//! keeps the conversation's own mode, which the turns without execution
//! controls (a schedule the model created, on the `automation` transport)
//! run with.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};

use super::{Envelope, bind_and_request};
use butler_turn::btcc::{
    AccessMode, ControlResolution, ControlSource, ExecutionControls, ReasoningEffort,
    stored_binding_access_mode,
};
use butler_turn::workspace::{
    SessionBindingStore, SessionBindingStoreConfig, WorkspaceStorageProfile,
};

const CHAT: &str = "chat-1";
const SESSION: &str = "butler/app-chat-1";
const MODEL: &str = "openai/gpt-6-luna";

#[tokio::test]
async fn schedule_override_never_becomes_the_mode_of_turns_without_controls() {
    for (conversation, schedule) in [
        (AccessMode::AskFirst, AccessMode::FullAccess),
        (AccessMode::FullAccess, AccessMode::AskFirst),
        (AccessMode::ReadOnly, AccessMode::FullAccess),
    ] {
        let root = std::env::temp_dir().join(format!(
            "butler-ingress-bind-access-{}",
            uuid::Uuid::new_v4()
        ));
        let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
            path: root.join("sessions.sqlite"),
            storage_profile: WorkspaceStorageProfile::Durable,
            clock: Arc::new(crate::host::SystemIdentity),
        })
        .await
        .unwrap();

        let scheduled = app_envelope("turn-1", &schedule, &conversation);
        let request = bind_and_request(&scheduled, &bindings, &root, &root)
            .await
            .unwrap();
        let controls = request.execution_controls.as_ref().unwrap().as_json();
        assert_eq!(
            controls["access_mode"],
            json!(schedule),
            "the run's own access"
        );

        let later = automation_envelope("automation:model-schedule:1");
        let request = bind_and_request(&later, &bindings, &root, &root)
            .await
            .unwrap();
        assert!(request.execution_controls.is_none());
        let binding = bindings.get_by_session_id(SESSION).await.unwrap().unwrap();
        assert_eq!(
            stored_binding_access_mode(&binding),
            conversation,
            "a {schedule:?} schedule changed the mode of a {conversation:?} conversation"
        );
        remove(&root);
    }
}

/// An App turn whose controls carry `turn_access` as a message override, in
/// a conversation whose own mode is `conversation`.
fn app_envelope(turn_id: &str, turn_access: &AccessMode, conversation: &AccessMode) -> Envelope {
    let controls = ExecutionControls::create(
        turn_id,
        CHAT,
        ControlResolution {
            model: MODEL.into(),
            reasoning_effort: ReasoningEffort::Medium,
            access_mode: turn_access.clone(),
            plan_mode: false,
            source: ControlSource::MessageOverride,
            session_control_revision: 0,
            catalog_generation: "catalog-1".into(),
            model_fallback: None,
            subsession_result: None,
        },
        "2026-09-28T00:00:00.000Z",
    )
    .unwrap();
    let message_id = format!("message-{turn_id}");
    envelope(json!({
        "eventId": format!("event-{turn_id}"),
        "transport": "app",
        "accountId": "local",
        "peer": {"kind": "dm", "id": CHAT},
        "sender": {"id": "app-user"},
        "message": {"id": message_id, "text": "Summarize my day.",
            "timestamp": "2026-09-28T00:00:00.000Z"},
        "routingHints": {"sessionId": SESSION, "turnId": turn_id},
        "executionControls": controls.as_json(),
        "appTurnContext": {
            "version": 1,
            "session": {"id": CHAT, "kind": "chat", "accessMode": conversation},
            "conversation": {"chatId": CHAT, "userMessageId": message_id,
                "turnId": turn_id, "turnAttempt": 1},
            "model": {"requestedModelRef": MODEL, "reasoningEffort": "medium"},
        },
    }))
}

/// A run of a schedule the model created: no execution controls.
fn automation_envelope(event_id: &str) -> Envelope {
    envelope(json!({
        "eventId": event_id,
        "transport": "automation",
        "accountId": "local",
        "peer": {"kind": "dm", "id": SESSION},
        "sender": {"id": "butler-automation", "displayName": "Butler Schedule"},
        "message": {"id": event_id, "text": "Summarize my day.",
            "timestamp": "2026-09-28T01:00:00.000Z"},
        "routingHints": {"sessionId": SESSION},
    }))
}

fn envelope(value: Value) -> Envelope {
    serde_json::from_value(value).unwrap()
}

fn remove(root: &Path) {
    let _ = std::fs::remove_dir_all(root);
}
