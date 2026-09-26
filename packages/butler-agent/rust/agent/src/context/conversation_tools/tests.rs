use serde_json::json;
use std::{cmp::Ordering, sync::Arc};

use super::{
    super::{ContextBudgetEnvironment, ContextConversation},
    NativeConversationTools,
};
use crate::{
    configuration::ConfigurationWrites,
    conversation::{
        AgentConversationStore, AppendMessageInput, BeginTurnInput, CanonicalMemoryReadBinding,
        ConversationIdentityClock, ConversationLocaleCollation, ConversationOriginKind,
        ConversationRole, ConversationStoreConfig, conversation_session_id_for_durable_session,
    },
    locale::LocaleCollation,
    models::{
        ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
    },
};

struct Clock;
impl ConversationIdentityClock for Clock {
    fn id(&self, prefix: &'static str) -> String {
        format!("{prefix}_{}", uuid::Uuid::new_v4())
    }
    fn now_iso(&self) -> String {
        "2026-09-20T00:00:00.000Z".into()
    }
}
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-20T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_790_000_000_000
    }
}
struct Collation;
impl ConversationLocaleCollation for Collation {
    fn compare(&self, left: &str, right: &str) -> Ordering {
        left.cmp(right)
    }
}

#[tokio::test]
async fn canonical_write_lists_and_reads_legacy_context() {
    let root = std::env::temp_dir().join(format!(
        "butler-conversation-tools-{}",
        uuid::Uuid::new_v4()
    ));
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: root.join("runtime/conversation-store.sqlite"),
        identity_clock: Arc::new(Clock),
        collation: Arc::new(Collation),
    })
    .await
    .unwrap();
    let canonical_session = conversation_session_id_for_durable_session("runtime-a");
    store
        .begin_turn(BeginTurnInput {
            gateway: "app".into(),
            external_session_id: "runtime-a".into(),
            session_id: Some(canonical_session.clone()),
            workspace_id: None,
            project_id: Some("project-a".into()),
            actor: "user".into(),
            request_id: Some("event-a".into()),
            turn_id: Some("ct_a".into()),
            now: Some("2026-09-20T00:00:00.000Z".into()),
        })
        .await
        .unwrap();
    let original = "Source sentence 😀 that must be returned.";
    store
        .append_user_message(AppendMessageInput {
            session_id: canonical_session,
            turn_id: Some("ct_a".into()),
            text: original.into(),
            message_id: Some("cm_a".into()),
            role: ConversationRole::User,
            status: None,
            visibility: None,
            provenance: None,
            source_gateway: Some("app".into()),
            source_ref: Some("event-a".into()),
            origin_kind: Some(ConversationOriginKind::UserInput),
            origin_ref: None,
            origin_reason: None,
            origin_version: None,
            origin_evidence: None,
            now: Some("2026-09-20T00:00:00.000Z".into()),
            parts: None,
        })
        .await
        .unwrap();
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.clone(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock),
            catalog.clone(),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            crate::models::provider_http_client().unwrap(),
            Arc::new(ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let context = Arc::new(ContextConversation::new(
        store.clone(),
        configuration,
        catalog,
        ContextBudgetEnvironment::default(),
    ));
    let tools = NativeConversationTools::new(root.clone(), context, 2);
    let binding = CanonicalMemoryReadBinding {
        runtime_session_id: "runtime-a".into(),
        turn_id: "ct_a".into(),
        project_id: Some("project-a".into()),
    };
    let list = tools
        .list(binding, json!({"scope":"current_project"}))
        .await
        .unwrap();
    assert_eq!(list["ok"], true);
    assert_eq!(list["returned"], 1);
    assert_eq!(list["sessions"][0]["recent_messages"][0]["text"], original);
    let read = tools
        .read_context("runtime-a".into(), json!({"query":"Source sentence"}))
        .await
        .unwrap();
    assert_eq!(read["ok"], true);
    assert_eq!(read["messages"][0]["text"], original);
    tools.close().await.unwrap();
    store.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
