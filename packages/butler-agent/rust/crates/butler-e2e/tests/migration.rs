//! K. Legacy data (SCENARIOS.md MIG-01) on the synthetic `F3-legacy` fixture.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fixtures::legacy_manifest;
use butler_e2e::e2e::scenario::{Fixture, Scenario, Setup};
use serde_json::Value;

/// Rows of the App DB that the migration must keep stable, as text.
fn db_dump(scenario: &Scenario) -> String {
    let path = scenario
        .sandbox
        .data
        .join("app-server/butler-client.sqlite");
    let db =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mut out = String::new();
    let mut schema = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap();
    for row in schema
        .query_map([], |row| {
            Ok(format!(
                "{}: {}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            ))
        })
        .unwrap()
    {
        out.push_str(&row.unwrap());
        out.push('\n');
    }
    let mut rows = db
        .prepare(
            "SELECT id, chat_id, role, text, created_at, legacy_note FROM messages ORDER BY id",
        )
        .unwrap();
    for row in rows
        .query_map([], |row| {
            Ok(format!(
                "{}|{}|{}|{}|{}|{:?}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?
            ))
        })
        .unwrap()
    {
        out.push_str(&row.unwrap());
        out.push('\n');
    }
    out
}

async fn assert_manifest(s: &Scenario, manifest: &Value) -> Result<(), HarnessError> {
    let chats = s.gw.get("/chats").await?;
    for chat in manifest["chats"].as_array().unwrap() {
        let id = chat["id"].as_str().unwrap();
        assert!(
            chats.text.contains(&format!("\"id\":\"{id}\"")),
            "chat {id} missing: {}",
            chats.text
        );
        let messages = s.gw.messages(id).await?;
        let legacy: Vec<&Value> = messages
            .iter()
            .filter(|message| {
                message["id"]
                    .as_str()
                    .is_some_and(|mid| mid.starts_with("legacy-m-"))
            })
            .collect();
        let expected = chat["messages"].as_array().unwrap();
        assert_eq!(legacy.len(), expected.len(), "{id}: {messages:?}");
        for (got, want) in legacy.iter().zip(expected) {
            for key in ["id", "role", "text", "created_at"] {
                assert_eq!(got[key], want[key], "{id}: {key} of {}", want["id"]);
            }
        }
    }
    Ok(())
}

/// MIG-01 — Opening a legacy data dir.
#[tokio::test]
#[ignore = "product gap: MIG-01-PRE-BTCC — a data dir whose App DB predates the BTCC runtime store (no agent-runtime/btcc.sqlite) is refused at start: `storage_bootstrap_failed: legacy Agent BTCC migration is unsupported`"]
async fn mig_01_legacy_data_dir_opens_with_all_content() -> Result<(), HarnessError> {
    let manifest = legacy_manifest()?;
    let mut s = Setup::new("MIG-01")?
        .fixture(Fixture::Legacy)
        .start()
        .await?;
    assert_manifest(&s, &manifest).await?;
    for file in manifest["preserved_files"].as_array().unwrap() {
        assert!(
            s.sandbox.data.join(file.as_str().unwrap()).is_file(),
            "legacy file {file} removed"
        );
    }
    s.agent.terminate().await?;
    let first = db_dump(&s);
    assert!(
        first.contains("imported-from-v0"),
        "unknown legacy column lost:\n{first}"
    );
    s.gw = s.agent.start_again().await?;
    assert_manifest(&s, &manifest).await?;
    s.agent.terminate().await?;
    assert_eq!(db_dump(&s), first, "second start rewrote migrated data");
    s.gw = s.agent.start_again().await?;
    s.finish().await
}

/// MIG-01 (current behavior) — the refused legacy dir is left untouched and
/// the refusal names the problem.
#[tokio::test]
async fn mig_01_unsupported_legacy_dir_is_refused_without_writes() -> Result<(), HarnessError> {
    let setup = Setup::new("MIG-01-REFUSE")?;
    let data = setup.sandbox.data.clone();
    butler_e2e::e2e::fixtures::legacy(&data, "openai/gpt-6-sol")?;
    let before = tree(&data);
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let output = launch
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(!output.status.success(), "legacy dir accepted?");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("legacy") && stderr.contains("unsupported"),
        "unclear refusal: {stderr}"
    );
    assert_eq!(
        tree(&data),
        before,
        "refused start modified the legacy data dir"
    );
    Ok(())
}

/// Relative path + content hash of every file under `root`, except the
/// empty service lock files (their inodes persist by design).
fn tree(root: &std::path::Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if !(path.extension().is_some_and(|ext| ext == "lock")
                && entry.metadata().is_ok_and(|m| m.len() == 0))
            {
                let bytes = std::fs::read(&path).unwrap_or_default();
                out.push((
                    path.strip_prefix(root).unwrap().display().to_string(),
                    butler_e2e::e2e::sha256_hex(&bytes),
                ));
            }
        }
    }
    out.sort();
    out
}

/// MIG-01b — An App DB from an older release (current runtime store, older
/// App schema plus an unknown column) is upgraded in place, keeps every chat
/// and the unknown column, and a second start writes nothing more.
#[tokio::test]
async fn mig_01b_older_app_schema_is_upgraded_in_place() -> Result<(), HarnessError> {
    let mut s = Setup::new("MIG-01B")?.start().await?;
    let mut ids = Vec::new();
    for title in ["Garden planning", "Tomato varieties"] {
        let reply =
            s.gw.post(
                "/sessions",
                serde_json::json!({"kind": "chat", "title": title}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
        ids.push((
            reply.data()["session"]["id"].as_str().unwrap().to_owned(),
            title,
        ));
    }
    s.agent.terminate().await?;
    // Downgrade: the previous App schema had no pinned/archived columns; an
    // unknown column carries a value the product must keep.
    {
        let path = s.sandbox.data.join("app-server/butler-client.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(
            "ALTER TABLE chats DROP COLUMN pinned;
             ALTER TABLE chats DROP COLUMN archived;
             ALTER TABLE chats ADD COLUMN legacy_note TEXT;
             UPDATE chats SET legacy_note = 'imported-from-v0';",
        )
        .unwrap();
    }
    s.gw = s.agent.start_again().await?;
    let chats = s.gw.get("/chats").await?;
    for (id, title) in &ids {
        assert!(
            chats.text.contains(id.as_str()) && chats.text.contains(title),
            "{id} lost: {}",
            chats.text
        );
    }
    let pin =
        s.gw.post(
            &format!("/sessions/{}/pin", ids[0].0),
            serde_json::json!({"pinned": true}),
        )
        .await?;
    assert!(pin.status < 500, "{}", pin.text);
    s.agent.terminate().await?;
    let dump = |s: &Scenario| {
        let db = rusqlite::Connection::open_with_flags(
            s.sandbox.data.join("app-server/butler-client.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut statement = db
            .prepare("SELECT id, title, legacy_note, pinned, archived FROM chats ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| {
                Ok(format!(
                    "{}|{}|{:?}|{}|{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
    };
    let first = dump(&s);
    assert!(
        first
            .iter()
            .filter(|row| row.contains("imported-from-v0"))
            .count()
            >= 2,
        "{first:?}"
    );
    s.gw = s.agent.start_again().await?;
    s.agent.terminate().await?;
    assert_eq!(dump(&s), first, "second start rewrote chats");
    s.gw = s.agent.start_again().await?;
    s.finish().await
}
