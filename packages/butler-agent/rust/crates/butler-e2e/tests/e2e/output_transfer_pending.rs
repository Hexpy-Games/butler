//! Pending output transfers preserve admission and ownership across real restarts.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod deletion;
mod schedules;
use super::output_blob_index::{Unreadable, chat, content, db, hash, scalar, schema, seed, setup};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::sqlite;
use butler_runtime::outputs::OutputStore;
use serde_json::json;
use std::path::{Path, PathBuf};

fn manifest(data: &Path, id: &str) -> PathBuf {
    data.join(format!("outputs/manifests/{id}.json"))
}
fn markers(data: &Path, session: &str) -> PathBuf {
    data.join("outputs/sessions").join(hash(session.as_bytes()))
}
fn app(s: &Scenario) -> Result<sqlite::Connection, HarnessError> {
    Ok(sqlite::open(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
    )?)
}
fn count(s: &Scenario, table: &str) -> Result<i64, HarnessError> {
    Ok(app(s)?.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?)
}
fn pending(s: &Scenario) -> Result<String, HarnessError> {
    Ok(app(s)?.query_row(
        "SELECT archive_id FROM app_output_transfers ORDER BY rowid LIMIT 1",
        [],
        |r| r.get(0),
    )?)
}
fn assert_pending(s: &Scenario, archive: &str) -> Result<(), HarnessError> {
    assert_eq!(pending(s)?, archive);
    let owner: String = app(s)?.query_row(
        "SELECT owner_id FROM app_session_context_gate WHERE session_id='general' AND owner_kind='relocate'", [], |r| r.get(0))?;
    assert_eq!(owner, archive);
    Ok(())
}
fn assert_finished(s: &Scenario) -> Result<(), HarnessError> {
    assert_eq!(count(s, "app_output_transfers")?, 0);
    assert_eq!(count(s, "app_session_context_gate")?, 0);
    assert!(!markers(&s.sandbox.data, "general").exists());
    Ok(())
}
async fn clear(s: &Scenario, status: u16) -> Result<serde_json::Value, HarnessError> {
    let r =
        s.gw.post("/sessions/general/clear", json!({"title":"Saved"}))
            .await?;
    assert_eq!(r.status, status, "{r:?}");
    Ok(r.data().clone())
}
// Install an actual I/O obstacle while the agent is stopped, after seeding a real index.
async fn blocked(s: &mut Scenario) -> Result<(String, Vec<u8>, Unreadable), HarnessError> {
    s.agent.terminate().await?;
    let id = seed(
        &s.sandbox.data,
        "general",
        "blocked",
        b"Retained output",
        true,
    )?;
    let path = manifest(&s.sandbox.data, &id);
    let bytes = std::fs::read(&path)?;
    std::fs::remove_file(&path)?;
    let obstacle = Unreadable::directory(path)?;
    s.gw = s.agent.start_again().await?;
    clear(s, 500).await?;
    Ok((id, bytes, obstacle))
}
fn restore(
    s: &Scenario,
    id: &str,
    bytes: Vec<u8>,
    obstacle: Unreadable,
) -> Result<(), HarnessError> {
    drop(obstacle);
    let path = manifest(&s.sandbox.data, id);
    std::fs::remove_dir(&path)?;
    std::fs::write(path, bytes)?;
    Ok(())
}
fn owned(s: &Scenario, id: &str, session: &str) -> Result<(), HarnessError> {
    assert_eq!(
        OutputStore::new(&s.sandbox.data).read(id)?.session_id,
        session
    );
    for table in ["outputs", "output_refs"] {
        let actual: String = db(&s.sandbox.data)?.query_row(
            &format!("SELECT session FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )?;
        assert_eq!(actual, session);
    }
    Ok(())
}

#[tokio::test]
async fn io_failure_opens_app_and_recovers_only_on_next_start() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("TRANSFER-OPEN")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    let archive = pending(&s)?;
    assert_pending(&s, &archive)?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let logs = s.agent.current_logs().await?;
    assert!(logs.contains("[outputs] transfer pending"), "{logs}");
    assert_pending(&s, &archive)?;
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{navigation:?}");
    let other = chat(&s).await?;
    let (_, turn) = s.turn(&other, "Tools").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    restore(&s, &id, bytes, obstacle)?;
    // No background retry: completing an unrelated request leaves the receipt intact.
    assert_eq!(s.gw.get("/navigation").await?.status, 200);
    assert_pending(&s, &archive)?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_finished(&s)?;
    owned(&s, &id, &archive)?;
    content(&s, &id, "Retained output").await?;
    s.finish().await
}

#[tokio::test]
async fn first_pending_failure_does_not_prevent_later_transfer() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("TRANSFER-LATER")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let second = chat(&s).await?;
    let (id, bytes, obstacle) = blocked(&mut s).await?;
    let first = pending(&s)?;
    s.agent.terminate().await?;
    restore(&s, &id, bytes, obstacle)?;
    // The first target cannot create its marker directory; the later target can.
    std::fs::write(markers(&s.sandbox.data, &first), b"obstacle")?;
    app(&s)?.execute("UPDATE chats SET archived=1 WHERE id=?1", [&second])?;
    // Pin the recovery loop, not a state reachable through clear.
    app(&s)?.execute("INSERT INTO app_output_transfers VALUES(?1)", [&second])?;
    s.gw = s.agent.start_again().await?;
    assert_pending(&s, &first)?;
    assert_eq!(count(&s, "app_output_transfers")?, 1);
    owned(&s, &id, &second)?;
    content(&s, &id, "Retained output").await?;
    s.agent.terminate().await?;
    std::fs::remove_file(markers(&s.sandbox.data, &first))?;
    s.gw = s.agent.start_again().await?;
    assert_finished(&s)?;
    owned(&s, &id, &second)?;
    s.finish().await
}

#[tokio::test]
async fn corrupt_manifest_does_not_jam_general_and_archive_delete_collects_it()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("TRANSFER-CORRUPT")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let bad = seed(&s.sandbox.data, "general", "bad", b"Unservable", true)?;
    let good = seed(&s.sandbox.data, "general", "good", b"Servable", true)?;
    std::fs::write(manifest(&s.sandbox.data, &bad), b"{")?;
    s.gw = s.agent.start_again().await?;
    let result = clear(&s, 200).await?;
    let archive = result["archived_session"]["id"].as_str().unwrap();
    assert_finished(&s)?;
    assert!(
        s.agent
            .logs()
            .contains("[outputs] ignoring unparseable manifest")
    );
    owned(&s, &good, archive)?;
    let bad_owner: String =
        db(&s.sandbox.data)?.query_row("SELECT session FROM outputs WHERE id=?1", [&bad], |r| {
            r.get(0)
        })?;
    assert_eq!(bad_owner, archive);
    assert!(OutputStore::new(&s.sandbox.data).read(&bad).is_err());
    content(&s, &good, "Servable").await?;
    let (_, turn) = s.turn("general", "Tools").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let r =
        s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
            .await?;
    assert_eq!(r.status, 200, "{r:?}");
    deletion::collected(&s, archive, &[&bad, &good], &[b"Unservable", b"Servable"])?;
    s.finish().await
}

#[tokio::test]
async fn invalid_index_id_moves_without_leaving_general_gated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("TRANSFER-INVALID")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    db(&s.sandbox.data)?.execute_batch(
        "INSERT INTO outputs VALUES('../invalid','general','m','t','Invalid',0,'2026-01-01');
         INSERT INTO output_refs VALUES('../invalid','general','t','m');",
    )?;
    s.gw = s.agent.start_again().await?;
    let result = clear(&s, 200).await?;
    let archive = result["archived_session"]["id"].as_str().unwrap();
    assert_finished(&s)?;
    for table in ["outputs", "output_refs"] {
        let owner: String = db(&s.sandbox.data)?.query_row(
            &format!("SELECT session FROM {table} WHERE id='../invalid'"),
            [],
            |r| r.get(0),
        )?;
        assert_eq!(owner, archive);
    }
    assert!(
        s.agent
            .logs()
            .contains("[outputs] ignoring invalid indexed output id")
    );
    let (_, turn) = s.turn("general", "Tools").await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    s.finish().await
}

#[tokio::test]
async fn corrupt_manifest_archive_delete_preserves_shared_live_blob() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("TRANSFER-SHARED")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let live = chat(&s).await?;
    s.agent.terminate().await?;
    let bad = seed(&s.sandbox.data, "general", "bad", b"Shared", true)?;
    let good = seed(&s.sandbox.data, &live, "live", b"Shared", true)?;
    std::fs::write(manifest(&s.sandbox.data, &bad), b"{")?;
    s.gw = s.agent.start_again().await?;
    let result = clear(&s, 200).await?;
    let archive = result["archived_session"]["id"].as_str().unwrap();
    assert_finished(&s)?;
    let r =
        s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
            .await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(!manifest(&s.sandbox.data, &bad).exists());
    assert_eq!(scalar(&s.sandbox.data, "SELECT count(*) FROM outputs")?, 1);
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_refs")?,
        1
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        1
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        0
    );
    assert_eq!(count(&s, "app_session_delete_cleanups")?, 0);
    owned(&s, &good, &live)?;
    content(&s, &good, "Shared").await?;
    s.finish().await
}
