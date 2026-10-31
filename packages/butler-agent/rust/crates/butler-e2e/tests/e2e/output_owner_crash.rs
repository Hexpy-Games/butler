//! Interrupted manifest/marker/index writes: only the manifest owns an output.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod archive_refs;
mod compatibility;
mod read_failure;
mod replay;
use super::output_blob_index::{
    blob, block_completion, chat, completed, content, db, delete, hash, scalar, schema, seed, setup,
};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_runtime::outputs::OutputStore;
use rusqlite::params;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn manifest(data: &Path, id: &str) -> PathBuf {
    data.join(format!("outputs/manifests/{id}.json"))
}
fn markers(data: &Path, session: &str) -> PathBuf {
    data.join("outputs/sessions").join(hash(session.as_bytes()))
}
fn owner(data: &Path, id: &str) -> Result<String, HarnessError> {
    Ok(OutputStore::new(data).read(id)?.session_id)
}
fn no_session_rows(data: &Path, session: &str) -> Result<(), HarnessError> {
    for table in ["outputs", "output_refs"] {
        let count: i64 = db(data)?.query_row(
            &format!("SELECT count(*) FROM {table} WHERE session=?1"),
            [session],
            |r| r.get(0),
        )?;
        assert_eq!(count, 0, "{table} still names {session}");
    }
    assert!(!markers(data, session).exists());
    Ok(())
}
fn live_rows(data: &Path, id: &str, session: &str) -> Result<(), HarnessError> {
    let actual: String =
        db(data)?.query_row("SELECT session FROM outputs WHERE id=?1", [id], |r| {
            r.get(0)
        })?;
    assert_eq!(actual, session);
    let refs: i64 = db(data)?.query_row(
        "SELECT count(*) FROM output_refs WHERE id=?1 AND session=?2",
        params![id, session],
        |r| r.get(0),
    )?;
    assert!(refs > 0, "live output lost its message references");
    assert_eq!(owner(data, id)?, session);
    Ok(())
}
// persist creates the target marker, replaces the manifest, then saves outputs.
// Leave the source marker, and optionally stop before that final index save.
fn interrupted_move(data: &Path, id: &str, target: &str, saved: bool) -> Result<(), HarnessError> {
    std::fs::create_dir_all(markers(data, target))?;
    std::fs::write(markers(data, target).join(id), [])?;
    let path = manifest(data, id);
    let mut output: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    output["session_id"] = json!(target);
    if saved {
        output["turn_id"] = json!("parent-turn");
        output["message_id"] = json!("parent-message");
    }
    std::fs::write(path, serde_json::to_vec(&output)?)?;
    if saved {
        db(data)?.execute(
            "UPDATE outputs SET session=?2,turn='parent-turn',message='parent-message' WHERE id=?1",
            params![id, target],
        )?;
        db(data)?.execute(
            "INSERT INTO output_refs VALUES(?1,?2,'parent-turn','parent-message')",
            params![id, target],
        )?;
    }
    Ok(())
}
fn migration(data: &Path, complete: bool) -> Result<(), HarnessError> {
    if !complete {
        db(data)?.execute_batch("UPDATE output_blob_backfill SET complete=0,cursor='';")?;
        block_completion(data)?;
    }
    Ok(())
}
async fn finish_migration(s: &mut Scenario, complete: bool) -> Result<(), HarnessError> {
    if !complete {
        s.agent.terminate().await?;
        db(&s.sandbox.data)?.execute_batch("DROP TRIGGER block_complete")?;
        s.gw = s.agent.start_again().await?;
        completed(s).await?;
    }
    Ok(())
}
async fn archive(s: &Scenario) -> Result<String, HarnessError> {
    let r =
        s.gw.post(
            "/sessions/general/clear",
            json!({"title":"Saved conversation"}),
        )
        .await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(r.data()["archived_session"]["id"]
        .as_str()
        .unwrap()
        .to_owned())
}
async fn adopt_delete(complete: bool, saved: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-ADOPT-DELETE")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let old = chat(&s).await?;
    let real = chat(&s).await?;
    s.agent.terminate().await?;
    let id = seed(&s.sandbox.data, &old, "adopt", b"Adopted", true)?;
    interrupted_move(&s.sandbox.data, &id, &real, saved)?;
    migration(&s.sandbox.data, complete)?;
    let bytes = blob(&s.sandbox.data, b"Adopted")?;
    s.gw = s.agent.start_again().await?;
    delete(&s, &old).await?;
    assert!(manifest(&s.sandbox.data, &id).is_file());
    assert!(bytes.is_file());
    no_session_rows(&s.sandbox.data, &old)?;
    if saved {
        live_rows(&s.sandbox.data, &id, &real)?;
    } else {
        let rows = OutputStore::new(&s.sandbox.data).summaries(&real)?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].output_id, id);
        assert_eq!(rows[0].session_id, real);
    }
    content(&s, &id, "Adopted").await?;
    finish_migration(&mut s, complete).await?;
    delete(&s, &real).await?;
    assert!(!manifest(&s.sandbox.data, &id).exists());
    assert!(!bytes.exists());
    no_session_rows(&s.sandbox.data, &real)?;
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blobs")?,
        0
    );
    assert_eq!(
        scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")?,
        0
    );
    s.finish().await
}
async fn adopt_archive(complete: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-ADOPT-ARCHIVE")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let real = chat(&s).await?;
    s.agent.terminate().await?;
    let own = seed(&s.sandbox.data, "general", "own", b"Own", true)?;
    let id = seed(&s.sandbox.data, "general", "adopt", b"Adopted", true)?;
    interrupted_move(&s.sandbox.data, &id, &real, true)?;
    // adopt leaves earlier source turn references as well as the new reference.
    db(&s.sandbox.data)?.execute(
        "INSERT INTO output_refs VALUES(?1,'general','earlier','earlier')",
        [&id],
    )?;
    migration(&s.sandbox.data, complete)?;
    s.gw = s.agent.start_again().await?;
    let archived = archive(&s).await?;
    live_rows(&s.sandbox.data, &id, &real)?;
    live_rows(&s.sandbox.data, &own, &archived)?;
    archive_refs::reference(&s.sandbox.data, &id, "earlier", &archived)?;
    no_session_rows(&s.sandbox.data, "general")?;
    let count: i64 = db(&s.sandbox.data)?.query_row(
        "SELECT count(*) FROM outputs WHERE session=?1",
        [&archived],
        |r| r.get(0),
    )?;
    assert_eq!(count, 1, "archive moved an output owned by another session");
    content(&s, &id, "Adopted").await?;
    content(&s, &own, "Own").await?;
    s.finish().await
}
async fn row_hint_delete(complete: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-TRANSFER-DELETE")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let source = chat(&s).await?;
    let target = chat(&s).await?;
    s.agent.terminate().await?;
    let id = seed(&s.sandbox.data, &source, "transfer", b"Transferred", true)?;
    interrupted_move(&s.sandbox.data, &id, &target, false)?;
    // Row-hint coverage only: gateway transfers start at undeletable general and keep markers.
    std::fs::remove_file(markers(&s.sandbox.data, &source).join(&id))?;
    migration(&s.sandbox.data, complete)?;
    s.gw = s.agent.start_again().await?;
    delete(&s, &source).await?;
    assert!(manifest(&s.sandbox.data, &id).is_file());
    let projected: String =
        db(&s.sandbox.data)?.query_row("SELECT session FROM outputs WHERE id=?1", [&id], |r| {
            r.get(0)
        })?;
    assert_eq!(projected, target);
    assert_eq!(owner(&s.sandbox.data, &id)?, target);
    let references: i64 = db(&s.sandbox.data)?.query_row(
        "SELECT count(*) FROM output_refs WHERE id=?1",
        [&id],
        |r| r.get(0),
    )?;
    assert_eq!(references, 0, "deleting the source removes its references");
    no_session_rows(&s.sandbox.data, &source)?;
    content(&s, &id, "Transferred").await?;
    finish_migration(&mut s, complete).await?;
    delete(&s, &target).await?;
    assert!(!manifest(&s.sandbox.data, &id).exists());
    assert!(!blob_path(&s.sandbox.data, b"Transferred").exists());
    no_session_rows(&s.sandbox.data, &target)?;
    s.finish().await
}
fn blob_path(data: &Path, body: &[u8]) -> PathBuf {
    let sha = hash(body);
    data.join("outputs/blobs").join(&sha[..2]).join(sha)
}
async fn temporary_marker(complete: bool, clear: bool) -> Result<(), HarnessError> {
    let setup = setup("OWNER-TEMP-MARKER")?;
    schema(&setup.sandbox.data, true)?;
    let mut s = setup.start().await?;
    let session = if clear {
        "general".to_owned()
    } else {
        chat(&s).await?
    };
    s.agent.terminate().await?;
    let id = seed(&s.sandbox.data, &session, "real", b"Real", true)?;
    // secure_fs::unique_temporary: .<name>.<pid>.<sequence>.<nanos>.tmp
    let temp = markers(&s.sandbox.data, &session).join(format!(".{id}.123.0.456.tmp"));
    std::fs::write(&temp, [])?;
    migration(&s.sandbox.data, complete)?;
    s.gw = s.agent.start_again().await?;
    if clear {
        let archived = archive(&s).await?;
        live_rows(&s.sandbox.data, &id, &archived)?;
        content(&s, &id, "Real").await?;
    } else {
        delete(&s, &session).await?;
        assert!(!manifest(&s.sandbox.data, &id).exists());
        finish_migration(&mut s, complete).await?;
        assert!(!blob_path(&s.sandbox.data, b"Real").exists());
    }
    assert!(!temp.exists());
    no_session_rows(&s.sandbox.data, &session)?;
    s.finish().await
}

#[tokio::test]
async fn adopt_delete_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    adopt_delete(true, true).await
}
#[tokio::test]
async fn adopt_delete_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    adopt_delete(false, true).await
}
#[tokio::test]
async fn adopt_archive_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    adopt_archive(true).await
}
#[tokio::test]
async fn adopt_archive_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    adopt_archive(false).await
}
#[tokio::test]
async fn row_hint_delete_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    row_hint_delete(true).await
}
#[tokio::test]
async fn row_hint_delete_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    row_hint_delete(false).await
}
#[tokio::test]
async fn temp_delete_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    temporary_marker(true, false).await
}
#[tokio::test]
async fn temp_delete_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    temporary_marker(false, false).await
}
#[tokio::test]
async fn temp_archive_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    temporary_marker(true, true).await
}
#[tokio::test]
async fn temp_archive_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    temporary_marker(false, true).await
}

#[tokio::test]
async fn adopt_before_index_save_delete_source_migrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    adopt_delete(true, false).await
}
#[tokio::test]
async fn adopt_before_index_save_delete_source_unmigrated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    adopt_delete(false, false).await
}
