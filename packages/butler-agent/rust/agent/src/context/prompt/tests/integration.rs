use super::*;
use crate::btcc::AdmissionContextPort;
use crate::conversation::{
    AppendMessageInput, BeginTurnInput, ConversationOriginKind, ConversationRole,
};
use crate::workspace::SessionRole as WorkspaceRole;

#[tokio::test]
async fn rich_ports_and_real_recent_store_feed_the_admission_adapter() {
    let root = temp("recent");
    let (assembler, conversation, _, _) = fixture(&root, true).await;
    conversation
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "session-1".into(),
            session_id: Some("conversation".into()),
            workspace_id: None,
            project_id: Some("proj".into()),
            actor: "user".into(),
            request_id: Some("old".into()),
            turn_id: Some("turn".into()),
            now: None,
        })
        .await
        .unwrap();
    for (id, text, source) in [
        ("old", "remember me", "old"),
        ("current", "exclude me", "event-1"),
    ] {
        conversation
            .append_user_message(AppendMessageInput {
                session_id: "conversation".into(),
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
            })
            .await
            .unwrap();
    }
    let request = request();
    let binding = binding(WorkspaceRole::Butler);
    let assembly = AdmissionContextPort::build_butler(&assembler, &request, &binding)
        .await
        .unwrap();
    assert!(ids(&assembly.live_configuration).contains(&"profile-projection"));
    assert!(ids(&assembly.runtime_state).contains(&"first-chat-onboarding"));
    assert!(ids(&assembly.retrieved_context).contains(&"hot-cache"));
    let assembly = AdmissionContextPort::include_recent(&assembler, &request, &binding, assembly)
        .await
        .unwrap();
    let recent = assembly
        .working_context
        .iter()
        .find(|value| value.id == "recent-conversation")
        .unwrap();
    assert!(recent.content.contains("remember me"));
    assert!(!recent.content.contains("exclude me"));
    conversation.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn cancelled_admission_stops_before_async_prompt_producers() {
    let root = temp("cancelled");
    let (assembler, conversation, profile_calls, cognition_calls) = fixture(&root, true).await;
    let request = request();
    request.preparation_cancellation.cancel();
    let error =
        AdmissionContextPort::build_butler(&assembler, &request, &binding(WorkspaceRole::Butler))
            .await
            .unwrap_err();
    assert_eq!(error.code(), "prompt_assembly_cancelled");
    assert!(profile_calls.lock().unwrap().is_empty());
    assert!(cognition_calls.lock().unwrap().is_empty());
    conversation.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}
