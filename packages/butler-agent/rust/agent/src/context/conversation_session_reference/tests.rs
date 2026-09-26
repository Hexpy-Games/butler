use std::{cmp::Ordering, sync::Arc};

use serde_json::json;

use crate::{
    cognition::{CognitionPathEnvironment, NativeExactMemoryQuery},
    conversation::{
        AgentConversationStore, AppendMessageInput, BeginTurnInput, CanonicalMemoryReadBinding,
        ConversationIdentityClock, ConversationLocaleCollation, ConversationOriginKind,
        ConversationRole, ConversationStoreConfig,
    },
    host::NativeMemorySourceReader,
};

use super::NativeConversationSessionReference;

struct Clock;
impl ConversationIdentityClock for Clock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4())
    }
    fn now_iso(&self) -> String {
        "2026-09-19T00:00:00.000Z".into()
    }
}
struct Collation;
impl ConversationLocaleCollation for Collation {
    fn compare(&self, a: &str, b: &str) -> Ordering {
        a.cmp(b)
    }
}

#[tokio::test]
async fn canonical_write_query_read_args_reopens_original_scalar() {
    let root = std::env::temp_dir().join(format!("butler-native-exact-{}", uuid::Uuid::new_v4()));
    let path = root.join("runtime/conversation-store.sqlite");
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path,
        identity_clock: Arc::new(Clock),
        collation: Arc::new(Collation),
    })
    .await
    .unwrap();
    store
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "runtime-1".into(),
            session_id: Some("cs_exact".into()),
            workspace_id: None,
            project_id: Some("project-1".into()),
            actor: "user".into(),
            request_id: Some("event-1".into()),
            turn_id: Some("ct_exact".into()),
            now: Some("2026-09-19T00:00:00.000Z".into()),
        })
        .await
        .unwrap();
    let original = "A private 😀 canonical sentence, unabridged.";
    store
        .append_user_message(AppendMessageInput {
            session_id: "cs_exact".into(),
            turn_id: Some("ct_exact".into()),
            text: original.into(),
            message_id: Some("cm_exact".into()),
            role: ConversationRole::User,
            status: None,
            visibility: None,
            provenance: None,
            source_gateway: Some("app".into()),
            source_ref: Some("event-1".into()),
            origin_kind: Some(ConversationOriginKind::UserInput),
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence: None,
            now: Some("2026-09-19T00:00:00.000Z".into()),
            parts: None,
        })
        .await
        .unwrap();
    let binding = CanonicalMemoryReadBinding {
        runtime_session_id: "runtime-1".into(),
        turn_id: "ct_exact".into(),
        project_id: Some("project-1".into()),
    };
    let query = NativeExactMemoryQuery::new(root.clone(), 2);
    let memory = Arc::new(NativeMemorySourceReader::new(
        root.clone(),
        CognitionPathEnvironment::default(),
    ));
    let read = NativeConversationSessionReference::new(root.clone(), 2, memory.clone());
    let hits = query
        .query(
            binding.clone(),
            json!({"query":"canonical","scope":"current_project"}),
        )
        .await
        .unwrap();
    assert_eq!(hits["ok"], true);
    assert_eq!(hits["returned"], 1);
    let args = hits["results"][0]["read_args"].clone();
    let source = read.read(binding.clone(), args).await.unwrap();
    assert_eq!(source["ok"], true);
    assert_eq!(source["text"], original);
    assert_eq!(source["conversation_message_id"], "cm_exact");
    query.close().await.unwrap();
    read.close().await.unwrap();
    store.close().await.unwrap();
    let reopened = NativeConversationSessionReference::new(root.clone(), 1, memory);
    let source = reopened
        .read(binding, hits["results"][0]["read_args"].clone())
        .await
        .unwrap();
    assert_eq!(source["text"], original);
    reopened.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
