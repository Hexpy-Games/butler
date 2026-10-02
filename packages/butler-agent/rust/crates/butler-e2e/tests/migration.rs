//! K. Legacy data (SCENARIOS.md MIG-01) on the synthetic `F3-legacy` fixture.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]

use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::fixtures::legacy_manifest;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_platform::sqlite;

/// MIG-01 — a data dir whose App DB predates the BTCC runtime store (no
/// `agent-runtime/btcc.sqlite`) is refused at start with a message that names
/// the folder, says it is unsupported and says what to do, and the refused
/// start writes nothing into it.
///
/// This replaces SCENARIOS.md's "legacy dir opens with all content migrated":
/// owner decision of 2026-09-27 that pre-BTCC data folders need not be
/// supported (recorded in the crate README, "Scenario decisions").
#[tokio::test]
async fn mig_01_pre_btcc_data_dir_is_refused_without_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let manifest = legacy_manifest()?;
    let setup = Setup::new("MIG-01")?;
    let data = setup.sandbox.data.clone();
    butler_e2e::e2e::fixtures::legacy(
        &data,
        "openai/gpt-6-sol",
        butler_e2e::e2e::fixtures::FIXTURE_TIME,
    )?;
    let before = tree(&data);
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let output = launch
        .command()
        .stdin(std::process::Stdio::null())
        .output()?;
    assert!(!output.status.success(), "pre-BTCC data dir accepted");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("legacy data folder is unsupported"),
        "refusal does not say the folder is unsupported: {stderr}"
    );
    assert!(
        stderr.contains(&data.display().to_string()),
        "refusal does not name the folder: {stderr}"
    );
    assert!(
        stderr.contains("BUTLER_DATA") && stderr.contains("Move this folder aside"),
        "refusal does not say what to do: {stderr}"
    );
    for file in manifest["preserved_files"].as_array().unwrap() {
        assert!(
            data.join(file.as_str().unwrap()).is_file(),
            "legacy file {file} removed"
        );
    }
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
    butler_e2e::gate!();
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
        let db = sqlite::open(&path).unwrap();
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
    let first = chat_rows(&s);
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
    assert_eq!(chat_rows(&s), first, "second start rewrote chats");
    s.gw = s.agent.start_again().await?;
    s.finish().await
}

/// The App DB chat rows MIG-01b checks, including the unknown column.
fn chat_rows(s: &Scenario) -> Vec<String> {
    let db = sqlite::open_with_flags(
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
}
