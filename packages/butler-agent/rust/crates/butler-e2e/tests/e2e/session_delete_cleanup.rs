//! A committed deletion attempts all cleanup and recovers without idle work.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod archive;
mod canon;
mod project_canon;
mod project_delete_owners;
mod project_handoffs;
mod project_owner;

use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use butler_platform::sqlite;
use rusqlite::{Connection, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, time::Duration};

struct Deleted {
    chat: String,
    hint: String,
    summary: PathBuf,
    upload: PathBuf,
    asset: PathBuf,
    output: String,
}

fn setup(name: &str) -> Result<Setup, HarnessError> {
    let setup = Setup::new(name)?.stub_cassette(super::browser_outputs::stub::cassette()?);
    // Match the existing idle probe's fixture: no pending memory consolidation.
    crate::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    Ok(setup)
}

fn app(s: &Scenario) -> Result<sqlite::Connection, HarnessError> {
    Ok(sqlite::open(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
    )?)
}

fn outputs(s: &Scenario) -> Result<sqlite::Connection, HarnessError> {
    Ok(sqlite::open(s.sandbox.data.join("outputs/index.sqlite"))?)
}

async fn chat(s: &Scenario) -> Result<String, HarnessError> {
    let reply = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    assert_eq!(reply.status, 201, "{reply:?}");
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}

async fn inject(s: &mut Scenario) -> Result<Deleted, HarnessError> {
    let chat = chat(s).await?;
    inject_chat(s, chat).await
}

async fn inject_chat(s: &mut Scenario, chat: String) -> Result<Deleted, HarnessError> {
    let (_, turn) = s.turn(&chat, "Publish").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let uploaded =
        s.gw.upload("note.txt", "text/plain", b"Notes", Some(&chat))
            .await?;
    assert_eq!(uploaded.status, 201, "{uploaded:?}");
    let upload = s
        .sandbox
        .data
        .join("app-server/message-files")
        .join(uploaded.data()["file"]["file_id"].as_str().unwrap());
    assert!(upload.exists());
    // Fixture shutdown must not leave canceled background projections behind.
    crate::memory_fixture::settle(&s.sandbox.data).await?;
    s.agent.terminate().await?;
    let db = app(s)?;
    let hint: String = db.query_row(
        "SELECT COALESCE(runtime_session_hint,'butler/app-'||id) FROM chats WHERE id=?1",
        [&chat],
        |r| r.get(0),
    )?;
    let conversation = sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    let id: String = conversation.query_row("SELECT conversation_session_id FROM conversation_bindings WHERE gateway='app' AND external_session_id=?1", [&hint], |r| r.get(0))?;
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    let summary = s
        .sandbox
        .data
        .join("cognition/memory/sessions")
        .join(format!("{}.md", &hash[..32]));
    std::fs::create_dir_all(summary.parent().unwrap())?;
    std::fs::write(&summary, "Earlier conversation summary")?;
    let hash = format!("{:x}", Sha256::digest(chat.as_bytes()));
    let asset = s
        .sandbox
        .data
        .join("app-server/assets")
        .join(&hash[..2])
        .join(format!("{hash}.png"));
    std::fs::create_dir_all(asset.parent().unwrap())?;
    std::fs::write(&asset, b"cleanup asset")?;
    db.execute(
        "INSERT INTO app_assets(id,sha256,mime,width,height,bytes,alt,source_url,created_at) VALUES(?2,?1,'image/png',1,1,13,'','','2026-01-01')",
        params![hash, chat],
    )?;
    db.execute("INSERT INTO app_asset_refs VALUES(?1,'chat',?1)", [&chat])?;
    let outputs = outputs(s)?;
    let output: String =
        outputs.query_row("SELECT id FROM outputs WHERE session=?1", [&chat], |r| {
            r.get(0)
        })?;
    assert!(
        s.sandbox
            .data
            .join("outputs/manifests")
            .join(format!("{output}.json"))
            .exists()
    );
    outputs.execute_batch("CREATE TRIGGER IF NOT EXISTS fail_delete BEFORE DELETE ON outputs BEGIN SELECT RAISE(ABORT,'injected'); END;")?;
    s.gw = s.agent.start_again().await?;
    Ok(Deleted {
        chat,
        hint,
        summary,
        upload,
        asset,
        output,
    })
}

fn count(db: &Connection, table: &str) -> i64 {
    db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

async fn fail_delete(s: &Scenario, deleted: &Deleted) -> Result<(), HarnessError> {
    assert!(deleted.upload.exists());
    assert!(deleted.summary.exists());
    assert!(deleted.asset.exists());
    let reply =
        s.gw.delete(&format!("/sessions/{}?permanent=true", deleted.chat))
            .await?;
    assert_eq!(reply.status, 500, "{reply:?}");
    let db = app(s)?;
    let remaining: i64 = db.query_row(
        "SELECT count(*) FROM chats WHERE id=?1",
        [&deleted.chat],
        |r| r.get(0),
    )?;
    assert_eq!(remaining, 0, "chat must already be committed deleted");
    let leftovers: i64 = outputs(s)?.query_row(
        "SELECT count(*) FROM outputs WHERE session=?1",
        [&deleted.chat],
        |r| r.get(0),
    )?;
    assert_eq!(leftovers, 1, "outputs failure must be exercised");
    assert!(
        !deleted.upload.exists(),
        "later message-file sweep was skipped"
    );
    assert!(
        !deleted.summary.exists(),
        "later continuity cleanup was skipped"
    );
    assert!(!deleted.asset.exists(), "later asset sweep was skipped");
    assert_eq!(count(&db, "app_file_sweep"), 0);
    assert_eq!(count(&db, "app_asset_sweep"), 0);
    let hint: String = db.query_row(
        "SELECT session_hint FROM app_session_delete_cleanups WHERE session_id=?1",
        [&deleted.chat],
        |r| r.get(0),
    )?;
    assert_eq!(hint, deleted.hint);
    assert_eq!(count(&db, "app_session_delete_cleanups"), 1);
    Ok(())
}

fn recovered(s: &Scenario, deleted: &Deleted) -> Result<(), HarnessError> {
    let outputs = outputs(s)?;
    for table in ["outputs", "output_refs"] {
        let remaining: i64 = outputs.query_row(
            &format!("SELECT count(*) FROM {table} WHERE session=?1"),
            [&deleted.chat],
            |r| r.get(0),
        )?;
        assert_eq!(remaining, 0, "{table} leftovers");
    }
    let root = s.sandbox.data.join("outputs");
    assert!(
        !root
            .join("sessions")
            .join(format!("{:x}", Sha256::digest(deleted.chat.as_bytes())))
            .exists()
    );
    assert!(
        !root
            .join("manifests")
            .join(format!("{}.json", deleted.output))
            .exists()
    );
    let db = app(s)?;
    assert_eq!(count(&db, "app_session_delete_cleanups"), 0);
    assert_eq!(count(&db, "app_file_sweep"), 0);
    assert_eq!(count(&db, "app_asset_sweep"), 0);
    assert!(!deleted.summary.exists());
    assert!(!deleted.upload.exists());
    assert!(!deleted.asset.exists());
    Ok(())
}

#[tokio::test]
async fn failed_step_runs_rest_and_recovers_on_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("DELETE-CLEANUP-RESTART")?.start().await?;
    let deleted = inject(&mut s).await?;
    fail_delete(&s, &deleted).await?;
    s.agent.terminate().await?;
    outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    s.gw = s.agent.start_again().await?;
    recovered(&s, &deleted)?;
    // start_again waits for instance, gateway and executor readiness. Use the
    // idle probe's committed memory barrier for the remaining startup work;
    // quota updates are conditional and are not emitted on every start.
    crate::memory_fixture::settle(&s.sandbox.data).await?;
    let mut watch = crate::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    let db = app(&s)?;
    let before: i64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    tokio::time::sleep(Duration::from_secs(60)).await;
    let after: i64 = db.query_row("PRAGMA data_version", [], |r| r.get(0))?;
    assert_eq!(after, before, "idle App DB commits after recovery");
    watch.assert_unchanged();
    eprintln!("DELETE-CLEANUP idle_seconds=60 app_db_commits=0");
    s.finish().await
}

#[tokio::test]
async fn next_permanent_delete_recovers_previous_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("DELETE-CLEANUP-CHANGE")?.start().await?;
    let deleted = inject(&mut s).await?;
    fail_delete(&s, &deleted).await?;
    outputs(&s)?.execute_batch("DROP TRIGGER fail_delete")?;
    let other = chat(&s).await?;
    let reply =
        s.gw.delete(&format!("/sessions/{other}?permanent=true"))
            .await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    recovered(&s, &deleted)?;
    assert_eq!(
        app(&s)?.query_row(
            "SELECT count(*) FROM chats WHERE id IN (?1,?2)",
            params![deleted.chat, other],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    s.finish().await
}
