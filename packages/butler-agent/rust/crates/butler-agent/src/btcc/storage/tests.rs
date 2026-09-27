use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};

use super::*;

const MANIFEST: &str = "test-btcc-manifest";
static FIXTURE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

#[tokio::test]
async fn opens_full_schema_preserves_deployed_columns_and_closes_owner() {
    let fixture = Fixture::activated();
    {
        let connection = Connection::open(&fixture.path).expect("seed connection");
        connection
            .execute_batch(
                "CREATE TABLE btcc_messages (message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, \
                 turn_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, \
                 idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, deployment_note TEXT); \
                 INSERT INTO btcc_messages VALUES \
                 ('message-1', 'session-1', 'turn-1', 'user', 'sentinel', 'key-1', 'now', 'keep-me');",
            )
            .expect("seed deployed table");
    }
    let storage = BtccStorage::open(fixture.config("owner-a"))
        .await
        .expect("open storage");
    assert_eq!(storage.owner_id(), "owner-a");
    assert_eq!(storage.owner_generation(), 1);

    let (missing, note, journal, foreign_keys, synchronous, busy_timeout) = storage
        .execute(|connection| {
            let mut expected = Vec::new();
            for schema in [
                schema::core::CORE_SCHEMA,
                schema::work::WORK_SCHEMA,
                schema::effects::EFFECTS_SCHEMA,
                schema::authority::AUTHORITY_SCHEMA,
                schema::subsession::SUBSESSION_SCHEMA,
                schema::legacy::LEGACY_SCHEMA,
            ] {
                expected.extend(schema.lines().filter_map(|line| {
                    line.trim()
                        .strip_prefix("CREATE TABLE IF NOT EXISTS ")
                        .and_then(|tail| tail.split_whitespace().next())
                        .map(|name| name.trim_end_matches('(').to_owned())
                }));
            }
            let mut missing = Vec::new();
            for table in expected {
                let exists = connection
                    .query_row(
                        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                        [&table],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(StorageError::sqlite)?
                    .is_some();
                if !exists {
                    missing.push(table);
                }
            }
            let note = connection
                .query_row(
                    "SELECT deployment_note FROM btcc_messages WHERE message_id = 'message-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::sqlite)?;
            let journal = pragma_text(connection, "journal_mode")?;
            let foreign_keys = pragma_i64(connection, "foreign_keys")?;
            let synchronous = pragma_i64(connection, "synchronous")?;
            let busy_timeout = pragma_i64(connection, "busy_timeout")?;
            Ok((
                missing,
                note,
                journal,
                foreign_keys,
                synchronous,
                busy_timeout,
            ))
        })
        .await
        .expect("inspect schema");
    assert!(missing.is_empty(), "missing tables: {missing:?}");
    assert_eq!(note, "keep-me");
    assert_eq!(journal.to_ascii_lowercase(), "wal");
    assert_eq!(foreign_keys, 1);
    assert_eq!(synchronous, 1);
    assert_eq!(busy_timeout, 5_000);

    storage.close().await.expect("close storage");
    storage.close().await.expect("repeat close shares success");
    let connection = Connection::open(&fixture.path).expect("inspect closed owner");
    let status: String = connection
        .query_row(
            "SELECT status FROM btcc_runtime_owners WHERE owner_id = 'owner-a'",
            [],
            |row| row.get(0),
        )
        .expect("owner row");
    assert_eq!(status, "closed");
    drop(connection);

    let mut ephemeral_config = fixture.config("owner-ephemeral");
    ephemeral_config.profile = StorageProfile::Ephemeral;
    let ephemeral = BtccStorage::open(ephemeral_config)
        .await
        .expect("open ephemeral storage");
    let journal = ephemeral
        .execute(|connection| pragma_text(connection, "journal_mode"))
        .await
        .expect("ephemeral journal mode");
    assert_eq!(journal.to_ascii_lowercase(), "delete");
    ephemeral.close().await.expect("close ephemeral storage");
}

#[tokio::test]
async fn close_drains_admitted_operations_and_rejects_later_work() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("owner-drain"))
        .await
        .expect("open storage");
    let completed = Arc::new(AtomicUsize::new(0));
    {
        let lane = storage.inner.lane.lock().await;
        let sender = lane.sender.as_ref().expect("open lane");
        for value in 0..8 {
            let completed = Arc::clone(&completed);
            sender
                .try_send(Box::new(move |connection, _owner| {
                    connection
                        .execute(
                            "INSERT INTO btcc_records (record_id, kind, sha256, content_json) \
                             VALUES (?1, 'test', ?1, '{}')",
                            [format!("queued-{value}")],
                        )
                        .expect("queued SQL");
                    completed.fetch_add(1, Ordering::SeqCst);
                }))
                .expect("bounded queue has capacity");
        }
    }
    storage.close().await.expect("drained close");
    assert_eq!(completed.load(Ordering::SeqCst), 8);
    let error = storage
        .execute(|_connection| Ok(()))
        .await
        .expect_err("closed owner rejects work");
    assert_eq!(error.code(), "sqlite_owner_closed");
}

#[tokio::test]
async fn cancelled_first_close_does_not_abandon_owner_completion() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("owner-cancelled-close"))
        .await
        .expect("open storage");
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    {
        let lane = storage.inner.lane.lock().await;
        lane.sender
            .as_ref()
            .expect("open lane")
            .try_send(Box::new(move |_connection, _owner| {
                started_tx.send(()).expect("signal blocking job");
                release_rx.recv().expect("release blocking job");
            }))
            .expect("queue blocking job");
    }
    tokio::task::spawn_blocking(move || started_rx.recv())
        .await
        .expect("join start signal")
        .expect("blocking job started");
    let first_storage = storage.clone();
    let first_close = tokio::spawn(async move { first_storage.close().await });
    crate::testing::eventually("close to detach the lane sender", || {
        storage
            .inner
            .lane
            .try_lock()
            .is_ok_and(|lane| lane.sender.is_none())
    })
    .await;
    first_close.abort();
    release_tx.send(()).expect("release queued job");

    tokio::time::timeout(std::time::Duration::from_secs(2), storage.close())
        .await
        .expect("replacement close did not stall")
        .expect("replacement close observes shared success");
    let connection = Connection::open(&fixture.path).expect("inspect closed owner");
    let status: String = connection
        .query_row(
            "SELECT status FROM btcc_runtime_owners WHERE owner_id = 'owner-cancelled-close'",
            [],
            |row| row.get(0),
        )
        .expect("owner row");
    assert_eq!(status, "closed");
}

#[tokio::test]
async fn cancelled_operation_caller_does_not_abandon_admitted_sql() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("owner-cancelled-operation"))
        .await
        .expect("open storage");
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let operation_storage = storage.clone();
    let operation = tokio::spawn(async move {
        operation_storage
            .execute(move |connection| {
                started_tx.send(()).expect("signal admitted operation");
                release_rx.recv().expect("release admitted operation");
                connection
                    .execute(
                        "INSERT INTO btcc_records (record_id, kind, sha256, content_json) \
                         VALUES ('cancelled-caller', 'test', 'sha', '{}')",
                        [],
                    )
                    .map_err(StorageError::sqlite)?;
                Ok(())
            })
            .await
    });
    tokio::task::spawn_blocking(move || started_rx.recv())
        .await
        .expect("join start signal")
        .expect("operation was admitted");
    operation.abort();
    release_tx.send(()).expect("release admitted operation");

    let inserted = storage
        .execute(|connection| {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM btcc_records WHERE record_id = 'cancelled-caller'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(StorageError::sqlite)
        })
        .await
        .expect("observe admitted SQL after caller cancellation");
    assert_eq!(inserted, 1);
    storage.close().await.expect("close storage");
}

#[tokio::test]
async fn dead_runtime_owner_is_terminated_before_claim_adoption() {
    struct DeadProcess;
    impl ProcessLiveness for DeadProcess {
        fn is_alive(&self, _identity: &RuntimeOwnerIdentity) -> bool {
            false
        }
    }

    let fixture = Fixture::activated();
    let mut config = fixture.config("owner-current");
    config.process_liveness = Arc::new(DeadProcess);
    let storage = BtccStorage::open(config).await.expect("open storage");
    storage
        .execute(|connection| {
            connection
                .execute(
                    "INSERT INTO btcc_runtime_owners (owner_id, host_id, process_id, \
                     process_started_at_ms, owner_generation, status, registered_at) \
                     VALUES ('owner-dead', 'test-host', 404, 1, 7, 'active', 'then')",
                    [],
                )
                .map_err(StorageError::sqlite)?;
            Ok(())
        })
        .await
        .expect("seed prior owner");
    assert!(
        storage
            .execute_with_owner(|connection, owner| {
                owner.can_adopt_claim_from(connection, "owner-dead")
            })
            .await
            .expect("adoption decision")
    );
    let status = storage
        .execute(|connection| {
            connection
                .query_row(
                    "SELECT status FROM btcc_runtime_owners WHERE owner_id = 'owner-dead'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::sqlite)
        })
        .await
        .expect("terminated owner status");
    assert_eq!(status, "terminated");
    storage.close().await.expect("close storage");
}

#[tokio::test]
async fn opener_cuts_over_an_r2_nonterminal_turn_without_reexecuting_it() {
    let fixture = Fixture::activated();
    {
        let connection = Connection::open(&fixture.path).expect("legacy fixture connection");
        schema::create_current(&connection).expect("current companion tables");
        connection
            .execute_batch(
                "DROP TABLE btcc_turns; \
                 CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, \
                 inbox_id TEXT NOT NULL UNIQUE, trigger_key TEXT NOT NULL, original_message_id TEXT NOT NULL, \
                 original_message TEXT NOT NULL, admission_snapshot_ref TEXT NOT NULL, \
                 model_selection_json TEXT NOT NULL, context_json TEXT NOT NULL, semantic_state TEXT NOT NULL, \
                 active_checkpoint_id TEXT, route TEXT, final_payload_json TEXT, delivery_outbox_id TEXT, \
                 canonical_assistant_message_id TEXT, revision INTEGER NOT NULL, execution_fence INTEGER NOT NULL, \
                 final_disposition TEXT); \
                 INSERT INTO btcc_turns VALUES ('legacy-turn', 'session-1', 'inbox-1', 'trigger-1', \
                 'message-1', 'continue the work', 'record-1', '{}', '{}', 'planning', NULL, NULL, NULL, \
                 NULL, NULL, 4, 2, NULL);",
            )
            .expect("legacy R2 Turn");
    }
    let storage = BtccStorage::open(fixture.config("owner-cutover"))
        .await
        .expect("open and cut over");
    let (state, revision, fence, disposition, outbox_status, evidence) = storage
        .execute(|connection| {
            let turn = connection
                .query_row(
                    "SELECT semantic_state, revision, execution_fence, final_disposition \
                     FROM btcc_turns WHERE turn_id = 'legacy-turn'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )
                .map_err(StorageError::sqlite)?;
            let outbox_status = connection
                .query_row(
                    "SELECT status FROM btcc_delivery_outbox WHERE turn_id = 'legacy-turn'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::sqlite)?;
            let evidence = connection
                .query_row(
                    "SELECT evidence_json FROM btcc_r3_legacy_turn_cutovers \
                     WHERE turn_id = 'legacy-turn'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .map_err(StorageError::sqlite)?;
            Ok((turn.0, turn.1, turn.2, turn.3, outbox_status, evidence))
        })
        .await
        .expect("cutover result");
    assert_eq!(state, "delivery_committed");
    assert_eq!(revision, 5);
    assert_eq!(fence, 3);
    assert_eq!(disposition, "completed");
    assert_eq!(outbox_status, "pending");
    assert!(evidence.contains("btcc.r3.legacy-turn-cutover.v2"));
    storage.close().await.expect("close cutover owner");
}

#[tokio::test]
async fn failed_activation_releases_the_connection_thread() {
    let fixture = Fixture::empty();
    let error = BtccStorage::open(fixture.config("owner-failed"))
        .await
        .err()
        .expect("activation must fail");
    assert_eq!(error.code(), "agent_btcc_storage_receipt_missing");
    let connection = Connection::open(&fixture.path).expect("connection released");
    connection
        .execute_batch("CREATE TABLE released_after_failed_open (id INTEGER)")
        .expect("failed owner left no lock");
}

fn pragma_text(connection: &Connection, name: &str) -> StorageResult<String> {
    connection
        .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .map_err(StorageError::sqlite)
}

fn pragma_i64(connection: &Connection, name: &str) -> StorageResult<i64> {
    connection
        .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .map_err(StorageError::sqlite)
}

pub(crate) struct Fixture {
    pub(super) path: PathBuf,
}

impl Fixture {
    fn empty() -> Self {
        let sequence = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let local_sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "butler-btcc-storage-{}-{sequence}-{local_sequence}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).expect("fixture directory");
        Self {
            path: directory.join("agent-btcc.sqlite"),
        }
    }

    pub(crate) fn activated() -> Self {
        let fixture = Self::empty();
        let connection = Connection::open(&fixture.path).expect("fixture connection");
        connection
            .execute_batch(
                "CREATE TABLE agent_storage_migration_receipt (singleton INTEGER PRIMARY KEY, \
                 manifest_id TEXT NOT NULL, receipt_json TEXT NOT NULL); \
                 CREATE TABLE agent_storage_activation_marker (singleton INTEGER PRIMARY KEY, \
                 manifest_id TEXT NOT NULL, marker_json TEXT NOT NULL);",
            )
            .expect("activation schema");
        connection
            .execute(
                "INSERT INTO agent_storage_migration_receipt VALUES (1, ?1, ?2)",
                params![MANIFEST, format!(
                    "{{\"schema\":\"butler.agent-btcc-storage-migration.v1\",\"manifestId\":\"{MANIFEST}\"}}"
                )],
            )
            .expect("receipt");
        connection
            .execute(
                "INSERT INTO agent_storage_activation_marker VALUES (1, ?1, ?2)",
                params![MANIFEST, format!(
                    "{{\"schema\":\"butler.agent-btcc-storage-activation.v1\",\"manifestId\":\"{MANIFEST}\",\"storageContract\":\"split-v1\",\"firstActivatedAt\":\"now\",\"activatedAt\":\"now\"}}"
                )],
            )
            .expect("activation");
        fixture
    }

    pub(crate) fn config(&self, owner_id: &str) -> BtccStorageConfig {
        BtccStorageConfig {
            path: self.path.clone(),
            profile: StorageProfile::Durable,
            activation: StorageActivation {
                manifest_id: MANIFEST.to_owned(),
            },
            runtime_owner: RuntimeOwnerIdentity {
                owner_id: owner_id.to_owned(),
                host_id: "test-host".to_owned(),
                process_id: std::process::id(),
                process_started_at_ms: 1,
            },
            process_liveness: Arc::new(ConservativeProcessLiveness),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(directory) = self.path.parent() {
            let _ignored_cleanup = std::fs::remove_dir_all(directory);
        }
    }
}
