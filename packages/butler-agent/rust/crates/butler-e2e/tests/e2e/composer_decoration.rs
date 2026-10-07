//! Composer decoration settings through the public gateway, including restart.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::json;

#[tokio::test]
async fn composer_decoration_settings_are_validated_and_durable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("COMPOSER-DECORATION")?.start().await?;
    let defaults = json!({"theme": "none", "character": true});
    assert_eq!(s.gw.settings().await?["composer_decoration"], defaults);
    for invalid in [
        json!({"theme":"unknown"}),
        json!({"character":1}),
        json!({"extra":true}),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"composer_decoration":invalid}))
                .await?;
        assert_eq!(reply.status, 400, "{}", reply.text);
        assert_eq!(s.gw.settings().await?["composer_decoration"], defaults);
    }
    for patch in [
        json!({"theme":"shoreline"}),
        json!({"theme":"none"}),
        json!({"theme":"cherry"}),
        json!({"character":false}),
    ] {
        let reply =
            s.gw.patch("/settings", json!({"composer_decoration":patch}))
                .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    let chosen = json!({"theme":"cherry", "character":false});
    assert_eq!(s.gw.settings().await?["composer_decoration"], chosen);
    let db = butler_platform::sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))
        .unwrap();
    let version = || {
        let value = db
            .query_row("PRAGMA data_version", [], |row| row.get::<_, u64>(0))
            .unwrap();
        // Finish the observer's own mapped read marks before its baseline.
        butler_platform::sqlite::sync_wal_index(&db).unwrap();
        value
    };
    let before = version();
    let repeated =
        s.gw.patch("/settings", json!({"composer_decoration":chosen}))
            .await?;
    assert_eq!(repeated.status, 200, "{}", repeated.text);
    assert_eq!(
        version(),
        before,
        "unchanged settings perform zero database writes"
    );
    drop(db);
    s.restart().await?;
    assert_eq!(s.gw.settings().await?["composer_decoration"], chosen);
    s.finish().await
}

#[tokio::test]
async fn storage_operations_finish_before_idle() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("COMPOSER-IDLE")?
        .cassette("TURN-01")
        .replay_only()
        .start()
        .await?;
    let prompt = "Write the numbers from one to twelve as English words, separated by single spaces, and nothing else.";
    let (_, turn) = s.turn("general", prompt).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let path = s.sandbox.data.join("runtime/session-store.sqlite");
    let db =
        butler_platform::sqlite::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let bindings: u64 = db
        .query_row("SELECT COUNT(*) FROM session_bindings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(bindings >= 2, "the turn created its runtime binding");
    let version = || {
        let value = db
            .query_row("PRAGMA data_version", [], |row| row.get::<_, u64>(0))
            .unwrap();
        // Finish the observer's own mapped read marks before its baseline.
        butler_platform::sqlite::sync_wal_index(&db).unwrap();
        value
    };
    let indexes = wal_indexes(&s.sandbox.data);
    let graph = indexes
        .iter()
        .find(|(path, _, _)| path.ends_with("graph.sqlite-shm"))
        .unwrap()
        .0
        .with_file_name("graph.sqlite");
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    while !projection_settled(&s.sandbox.data, &graph) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "canonical catch-up did not settle"
        );
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let before_version = version();
    let before = wal_indexes(&s.sandbox.data);
    assert!(
        before
            .iter()
            .any(|(path, _, _)| path.ends_with("runtime/session-store.sqlite-shm"))
    );
    assert!(
        before
            .iter()
            .any(|(path, _, _)| path.ends_with("graph.sqlite-shm"))
    );
    for _ in 0..9 {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        assert_eq!(version(), before_version, "zero idle session DB commits");
        assert_wal_indexes_unchanged(&before, &wal_indexes(&s.sandbox.data));
    }
    drop(db);
    assert_native_wal_locks(&s.sandbox.data);
    s.finish().await
}

fn wal_indexes(
    root: &std::path::Path,
) -> Vec<(std::path::PathBuf, std::time::SystemTime, Vec<u8>)> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(wal_indexes(&path));
        } else if path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .ends_with(".sqlite-shm")
        {
            files.push((
                path.clone(),
                std::fs::metadata(&path).unwrap().modified().unwrap(),
                std::fs::read(path).unwrap(),
            ));
        }
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn assert_wal_indexes_unchanged(
    before: &[(std::path::PathBuf, std::time::SystemTime, Vec<u8>)],
    after: &[(std::path::PathBuf, std::time::SystemTime, Vec<u8>)],
) {
    assert_eq!(after.len(), before.len(), "complete WAL-index inventory");
    for (before, after) in before.iter().zip(after) {
        assert_eq!(after.0, before.0, "complete ordered WAL-index inventory");
        assert_eq!(
            after.1,
            before.1,
            "zero idle WAL-index writes: {}",
            after.0.display()
        );
        assert_eq!(
            after.2,
            before.2,
            "complete WAL-index content: {}",
            after.0.display()
        );
    }
}

fn assert_native_wal_locks(root: &std::path::Path) {
    for relative in [
        "runtime/session-store.sqlite-shm",
        "runtime/conversation-store.sqlite-shm",
        "agent-runtime/btcc.sqlite-shm",
        "app-server/butler-client.sqlite-shm",
    ] {
        if let Some(owner) =
            butler_platform::sqlite::wal_index_lock_owner(&root.join(relative)).unwrap()
        {
            assert_ne!(owner, 0, "native SQLite lock remains held: {relative}");
            assert_ne!(owner, std::process::id(), "native process owns the lock");
        }
    }
}

fn projection_settled(data: &std::path::Path, graph: &std::path::Path) -> bool {
    if !super::memory_idle::catchup_checkpoint_current(data, graph) {
        return false;
    }
    let db =
        butler_platform::sqlite::open_with_flags(graph, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    // The fixture has no embedding engine. Its runnable source, semantic and
    // hot-cache stages must finish before the unchanged idle inventory starts.
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM memory_projection_jobs) AND NOT EXISTS(
        SELECT 1 FROM memory_projection_jobs WHERE
        json_extract(source_state,'$.state') IS NOT 'complete' OR
        json_extract(semantic_graph_state,'$.state') IS NOT 'complete' OR
        json_extract(hot_cache_state,'$.state') IS NOT 'complete')",
        [],
        |row| row.get(0),
    )
    .unwrap()
}
