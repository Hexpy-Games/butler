use std::sync::Arc;

use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::conversation::{
    AgentConversationStore, AppendMessageInput, BeginTurnInput, ConversationPartKind,
    ConversationStoreConfig, MessagePartInput,
};
use crate::host::SystemIdentity;
use crate::locale::LocaleCollation;

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn actual_canonical_writer_to_profile_facts_preserves_source_identity() {
    let directory = Directory(
        std::env::temp_dir().join(format!("butler-profile-source-{}", uuid::Uuid::new_v4())),
    );
    let path = directory.0.join("conversation.sqlite");
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: path.clone(),
        identity_clock: Arc::new(SystemIdentity),
        collation: Arc::new(LocaleCollation::new("en-US").unwrap()),
    })
    .await
    .unwrap();
    store
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "source".into(),
            session_id: Some("session".into()),
            workspace_id: None,
            project_id: None,
            actor: "user".into(),
            request_id: Some("request".into()),
            turn_id: Some("turn".into()),
            now: None,
        })
        .await
        .unwrap();
    let created = store.append_user_message(input()).await.unwrap();
    let mut assistant = input();
    assistant.message_id = Some("assistant".into());
    assistant.source_ref = Some("response".into());
    assistant.now = Some("2024-01-01T00:00:00.500Z".into());
    assistant.role = ConversationRole::Assistant;
    assistant.origin_kind = Some(ConversationOriginKind::AssistantPublic);
    store.append_assistant_message(assistant).await.unwrap();
    let mut next = input();
    next.message_id = Some("second".into());
    next.source_ref = Some("request-second".into());
    next.now = Some("2024-01-01T00:00:01.000Z".into());
    store.append_user_message(next).await.unwrap();
    store.close().await.unwrap();

    // The production Profile owner calls this synchronous source reader from
    // its tracked blocking lane. Exercise the actual factory the same way.
    let source = ProfileConversationSources::new(path.clone());
    let projected = tokio::task::spawn_blocking(move || {
        let mut reader = source.open().unwrap();
        assert!(reader.read_message("absent").unwrap().is_none());
        let projected = reader.read_message("message").unwrap().unwrap();
        for (offset, expected) in [(0.0, "message"), (1.0, "second")] {
            let page = reader
                .read_cognition_messages(CanonicalProfileScan {
                    since: None,
                    offset,
                    limit: 1.0,
                })
                .unwrap();
            assert_eq!(page.len(), 1);
            assert_eq!(page[0].id, expected);
            assert_eq!(page[0].parts[0].scalars[0].text, "  안녕🙂\n");
        }
        let page = reader
            .read_cognition_messages(CanonicalProfileScan {
                since: Some("2024-01-01T00:00:00.750Z".into()),
                offset: 0.0,
                limit: 1_000.0,
            })
            .unwrap();
        assert_eq!(
            page.iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["second"]
        );
        reader.close().unwrap();
        projected
    })
    .await
    .unwrap();
    assert_eq!(projected.id, "message");
    assert_eq!(projected.role, "user");
    assert_eq!(projected.origin_kind, "user_input");
    assert_eq!(projected.created_at, created.message.created_at);
    assert_eq!(projected.parts.len(), 2);
    assert_eq!(projected.parts[0].part_id, created.parts[0].id);
    assert_eq!(projected.parts[0].part_index, 0.0);
    let scalar = &projected.parts[0].scalars[0];
    assert_eq!(scalar.pointer, "/0/text");
    assert_eq!(scalar.text, "  안녕🙂\n");
    assert_eq!(
        scalar.source_hash,
        format!("{:x}", Sha256::digest(scalar.text.as_bytes()))
    );
    assert!(projected.parts[1].scalars.is_empty());

    let source = ProfileConversationSources::new(path);
    drop(source.open().unwrap());
    let missing = ProfileConversationSources::new(directory.0.join("missing.sqlite"));
    match missing.open() {
        Err(error) => assert_eq!(error.code, "conversation_source_unavailable"),
        Ok(_) => panic!("missing source must not become empty profile facts"),
    }
}

fn input() -> AppendMessageInput {
    AppendMessageInput {
        session_id: "session".into(),
        turn_id: Some("turn".into()),
        text: String::new(),
        message_id: Some("message".into()),
        role: ConversationRole::User,
        status: None,
        visibility: None,
        provenance: None,
        source_gateway: Some("app".into()),
        source_ref: Some("request".into()),
        origin_kind: Some(ConversationOriginKind::UserInput),
        origin_ref: None,
        origin_reason: None,
        origin_version: None,
        origin_evidence: None,
        now: Some("2024-01-01T00:00:00.000Z".into()),
        parts: Some(vec![
            MessagePartInput {
                kind: ConversationPartKind::MessageContent,
                content_json: json!([{"text":"  안녕🙂\n"},{"type":"image"},{"text":""}]),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: None,
            },
            MessagePartInput {
                kind: ConversationPartKind::AttachmentRef,
                content_json: json!({"text":"not a text scalar"}),
                tool_call_id: None,
                parent_tool_call_id: None,
                provider_shape: None,
                status: None,
            },
        ]),
    }
}
