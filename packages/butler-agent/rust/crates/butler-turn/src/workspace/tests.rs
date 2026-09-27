use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::Connection;
use serde_json::{Map, json};

use super::*;

struct TestClock(AtomicI64);

impl TestClock {
    fn new(millis: i64) -> Self {
        Self(AtomicI64::new(millis))
    }
}

impl WorkspaceClock for TestClock {
    fn now_epoch_millis(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }

    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|value| value.timestamp_millis())
    }

    fn iso_from_epoch_millis(&self, value: i64) -> WorkspaceResult<String> {
        Ok(DateTime::<Utc>::from_timestamp_millis(value)
            .unwrap()
            .to_rfc3339_opts(SecondsFormat::Millis, true))
    }
}

fn test_path(name: &str) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    std::env::temp_dir().join(format!(
        "butler-workspace-{name}-{}-{}.sqlite",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

async fn open(path: PathBuf) -> SessionBindingStore {
    SessionBindingStore::open(SessionBindingStoreConfig {
        path,
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(TestClock::new(1_757_808_000_000)),
    })
    .await
    .unwrap()
}

fn transport(thread_id: Option<&str>) -> SessionTransportBinding {
    SessionTransportBinding {
        transport: "app".into(),
        account_id: "local".into(),
        peer_id: "chat-1".into(),
        thread_id: thread_id.map(str::to_owned),
    }
}

fn upsert_input(session_id: &str, updated_at: &str) -> UpsertSessionBinding {
    UpsertSessionBinding {
        session_id: session_id.into(),
        role: SessionRole::Butler,
        project_id: Some("project-1".into()),
        app_project_id: OwnOptional::Absent,
        ledger_project_id: OwnOptional::Absent,
        workspace_path: "/workspace/one".into(),
        runtime_adapter_id: "claude-code".into(),
        model_provider_id: "anthropic".into(),
        model_ref: "anthropic/claude-sonnet".into(),
        runtime_session_ref: Some("runtime-1".into()),
        provider_thread_ref: None,
        transport_bindings: vec![transport(None)],
        lifecycle_state: None,
        created_at: None,
        updated_at: Some(updated_at.into()),
        last_active_at: None,
        metadata: Some(Map::from_iter([("fixture".into(), json!("typescript"))])),
    }
}

#[tokio::test]
async fn schema_is_additive_and_upsert_preserves_owned_null_and_transport_rules() {
    let path = test_path("schema-upsert");
    assert_eq!(
        session_store_path(PathBuf::from("/data").as_path()),
        PathBuf::from("/data/runtime/session-store.sqlite")
    );
    let legacy = Connection::open(&path).unwrap();
    legacy
        .execute_batch(
            "CREATE TABLE session_bindings (
               session_id TEXT PRIMARY KEY, role TEXT NOT NULL, lifecycle_state TEXT NOT NULL,
               project_id TEXT, workspace_path TEXT NOT NULL, runtime_adapter_id TEXT NOT NULL,
               model_provider_id TEXT NOT NULL, model_ref TEXT NOT NULL,
               runtime_session_ref TEXT, provider_thread_ref TEXT, created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL, last_active_at TEXT, metadata_json TEXT, retained TEXT
             );",
        )
        .unwrap();
    drop(legacy);

    let store = open(path.clone()).await;
    assert!(path.is_file());
    let settings = store
        .execute(|connection| {
            Ok((
                connection
                    .query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
                    .map_err(WorkspaceError::sqlite)?,
                connection
                    .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                    .map_err(WorkspaceError::sqlite)?,
                connection
                    .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                    .map_err(WorkspaceError::sqlite)?,
            ))
        })
        .await
        .unwrap();
    assert_eq!(settings, (5_000, "wal".into(), 1));

    let mut input = upsert_input("session-1", "2026-09-14T00:00:00.000Z");
    input.transport_bindings = vec![
        transport(Some("  thread-1\u{00a0}")),
        transport(Some("thread-1")),
        SessionTransportBinding {
            transport: "app".into(),
            account_id: "a".into(),
            peer_id: "z".into(),
            thread_id: None,
        },
    ];
    let first = store.upsert(input).await.unwrap();
    assert_eq!(first.app_project_id.as_deref(), Some("project-1"));
    assert_eq!(first.transport_bindings.len(), 2);
    assert_eq!(first.transport_bindings[0].account_id, "a");
    assert_eq!(
        first.transport_bindings[1].thread_id.as_deref(),
        Some("thread-1")
    );

    store
        .execute(|connection| {
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_failed_transport BEFORE INSERT
                     ON session_transport_bindings WHEN NEW.transport='fail'
                     BEGIN SELECT RAISE(ABORT, 'fixture transport failure'); END;",
                )
                .map_err(WorkspaceError::sqlite)
        })
        .await
        .unwrap();
    let mut rejected = upsert_input("session-1", "2026-09-14T00:00:00.500Z");
    rejected.workspace_path = "/must-roll-back".into();
    rejected.transport_bindings = vec![SessionTransportBinding {
        transport: "fail".into(),
        account_id: "local".into(),
        peer_id: "chat-1".into(),
        thread_id: None,
    }];
    assert!(store.upsert(rejected).await.is_err());
    assert_eq!(
        store
            .get_by_session_id("session-1")
            .await
            .unwrap()
            .unwrap()
            .workspace_path,
        "/workspace/one"
    );

    let mut cleared = upsert_input("session-1", "2026-09-14T00:00:01.000Z");
    cleared.project_id = Some("project-2".into());
    cleared.app_project_id = OwnOptional::Null;
    cleared.ledger_project_id = OwnOptional::Value("ledger-1".into());
    store.upsert(cleared).await.unwrap();
    let raw = store
        .execute(|connection| {
            connection
                .query_row(
                    "SELECT app_project_id, ledger_project_id FROM session_bindings
                     WHERE session_id='session-1'",
                    [],
                    |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(WorkspaceError::sqlite)
        })
        .await
        .unwrap();
    assert_eq!(raw, (None, "ledger-1".into()));

    let mut unknown = upsert_input("unknown-state", "2026-09-14T00:00:02.000Z");
    unknown.lifecycle_state = Some(SessionLifecycleState::Unknown("paused".into()));
    let unknown = store.upsert(unknown).await.unwrap();
    assert_eq!(
        unknown.lifecycle_state,
        SessionLifecycleState::Unknown("paused".into())
    );
    assert_eq!(
        unknown.last_active_at.as_deref(),
        Some("2026-09-14T00:00:02.000Z")
    );

    store
        .execute(|connection| {
            connection.execute(
                "UPDATE session_bindings SET metadata_json='[invalid-object]' WHERE session_id='session-1'",
                [],
            ).map_err(WorkspaceError::sqlite)?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        store
            .get_by_session_id("session-1")
            .await
            .unwrap()
            .unwrap()
            .metadata
            .is_none()
    );
    store.close().await.unwrap();
    let reopened = Connection::open(&path).unwrap();
    let columns: Vec<String> = reopened
        .prepare("PRAGMA table_info(session_bindings)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(columns.contains(&"retained".into()));
    assert!(columns.contains(&"app_project_id".into()));
    assert!(columns.contains(&"ledger_project_id".into()));
    drop(reopened);

    let ephemeral_path = test_path("ephemeral");
    let ephemeral = SessionBindingStore::open(SessionBindingStoreConfig {
        path: ephemeral_path.clone(),
        storage_profile: WorkspaceStorageProfile::Ephemeral,
        clock: Arc::new(TestClock::new(0)),
    })
    .await
    .unwrap();
    assert_eq!(
        ephemeral
            .execute(|connection| {
                connection
                    .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                    .map_err(WorkspaceError::sqlite)
            })
            .await
            .unwrap(),
        "delete"
    );
    ephemeral.close().await.unwrap();
    let _ignored = std::fs::remove_file(ephemeral_path);
    let _ignored = std::fs::remove_file(path);
}

#[tokio::test]
async fn stored_transport_bindings_survive_reads_and_session_updates() {
    let path = test_path("resolve");
    let store = open(path.clone()).await;
    let mut base = upsert_input("base", "2026-09-14T00:00:02.000Z");
    base.transport_bindings = vec![transport(None)];
    store.upsert(base).await.unwrap();
    let mut exact = upsert_input("exact", "2026-09-14T00:00:01.000Z");
    exact.transport_bindings = vec![transport(Some("thread"))];
    store.upsert(exact).await.unwrap();
    let exact_binding = store.get_by_session_id("exact").await.unwrap().unwrap();
    assert_eq!(
        exact_binding.transport_bindings,
        vec![transport(Some("thread"))]
    );
    store
        .update_lifecycle_state(
            "exact",
            SessionLifecycleState::Closed,
            Some("2026-09-14T00:00:03.000Z".into()),
        )
        .await
        .unwrap();
    let touched = store
        .touch_session("base", Some("2026-09-14T00:00:04.000Z".into()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        touched.last_active_at.as_deref(),
        Some("2026-09-14T00:00:04.000Z")
    );
    assert_eq!(
        store
            .list_sessions(Some(vec![SessionLifecycleState::Active]))
            .await
            .unwrap()
            .iter()
            .map(|binding| binding.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["base"]
    );
    store.close().await.unwrap();
    let _ignored = std::fs::remove_file(path);
}

#[tokio::test]
async fn rebind_and_execution_context_keep_cas_replay_and_revision_semantics() {
    let path = test_path("cas");
    let store = open(path.clone()).await;
    store
        .upsert(upsert_input("session", "2026-09-14T00:00:00.000Z"))
        .await
        .unwrap();
    let applied = store
        .rebind_workspace(RebindWorkspaceInput {
            session_id: "session".into(),
            expected_updated_at: "2026-09-14T00:00:00.000Z".into(),
            workspace_path: "/workspace/two".into(),
            metadata: Map::new(),
            updated_at: Some("2026-09-13T00:00:00.000Z".into()),
        })
        .await
        .unwrap();
    let RebindWorkspaceResult::Applied(binding) = applied else {
        panic!("expected apply")
    };
    assert_eq!(binding.updated_at, "2026-09-14T00:00:00.001Z");
    assert!(matches!(
        store
            .rebind_workspace(RebindWorkspaceInput {
                session_id: "session".into(),
                expected_updated_at: "stale".into(),
                workspace_path: "/stale".into(),
                metadata: Map::new(),
                updated_at: None,
            })
            .await
            .unwrap(),
        RebindWorkspaceResult::Changed(Some(_))
    ));
    let execution = ExecutionContextInput {
        session_id: "session".into(),
        expected_updated_at: binding.updated_at,
        operation_id: "relocation-1".into(),
        workspace_path: "/workspace/three".into(),
        project_id: None,
        app_project_id: Some("app-2".into()),
        ledger_project_id: Some("ledger-2".into()),
        metadata: Map::from_iter([("source".into(), json!("fixture"))]),
    };
    assert!(matches!(
        store
            .compare_and_set_execution_context(execution.clone())
            .await
            .unwrap(),
        RebindWorkspaceResult::Applied(_)
    ));
    assert!(matches!(
        store
            .compare_and_set_execution_context(execution)
            .await
            .unwrap(),
        RebindWorkspaceResult::Applied(_)
    ));
    store.delete_session("session").await.unwrap();
    assert!(matches!(
        store
            .compare_and_set_execution_context(ExecutionContextInput {
                session_id: "session".into(),
                expected_updated_at: "any".into(),
                operation_id: "other".into(),
                workspace_path: "/other".into(),
                project_id: None,
                app_project_id: None,
                ledger_project_id: None,
                metadata: Map::new(),
            })
            .await
            .unwrap(),
        RebindWorkspaceResult::Missing
    ));
    store.close().await.unwrap();
    let _ignored = std::fs::remove_file(path);
}

mod lifecycle;
