//! Blob ownership migration and cleanup through the real agent, with disk fixtures.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod backfill;
mod cleanup;
mod publication;
mod recovery;
mod shutdown;
mod strays;

use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use butler_platform::{secure_fs, sqlite};
use rusqlite::params;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn setup(name: &str) -> Result<Setup, HarnessError> {
    let setup = Setup::new(name)?.stub_cassette(super::browser_outputs::stub::cassette()?);
    crate::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    Ok(setup)
}
fn db(data: &Path) -> Result<sqlite::Connection, HarnessError> {
    Ok(sqlite::open(data.join("outputs/index.sqlite"))?)
}
// Legacy schema plus the approved migration schema, so triggers also work on main.
fn schema(data: &Path, complete: bool) -> Result<(), HarnessError> {
    secure_fs::create_private_dir_all(&data.join("outputs"))?;
    db(data)?.execute_batch(&format!("
        CREATE TABLE outputs(id TEXT PRIMARY KEY, session TEXT NOT NULL, message TEXT NOT NULL, turn TEXT NOT NULL, title TEXT NOT NULL, bytes INTEGER NOT NULL, created TEXT NOT NULL);
        CREATE INDEX outputs_session ON outputs(session);
        CREATE TABLE output_refs(id TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(id,turn));
        CREATE INDEX output_refs_turn ON output_refs(session,turn);
        CREATE TABLE output_blobs(sha TEXT NOT NULL, output_id TEXT NOT NULL, PRIMARY KEY(output_id,sha)) WITHOUT ROWID;
        CREATE TABLE output_blob_sweep(sha TEXT PRIMARY KEY) WITHOUT ROWID;
        CREATE TABLE output_blob_backfill(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL, complete INTEGER NOT NULL, indexed INTEGER NOT NULL, queued INTEGER NOT NULL);
        INSERT INTO output_blob_backfill VALUES(1,'',{},0,0);", i32::from(complete)))?;
    if complete {
        db(data)?.execute_batch("CREATE INDEX output_blobs_sha ON output_blobs(sha);")?;
    }
    Ok(())
}
fn blob(data: &Path, body: &[u8]) -> Result<PathBuf, HarnessError> {
    let sha = hash(body);
    let path = data.join("outputs/blobs").join(&sha[..2]).join(sha);
    secure_fs::create_private_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, body)?;
    Ok(path)
}
fn seed(
    data: &Path,
    session: &str,
    slot: &str,
    body: &[u8],
    indexed: bool,
) -> Result<String, HarnessError> {
    let id = hash(format!("{session}\0{slot}").as_bytes());
    let sha = hash(body);
    blob(data, body)?;
    let manifests = data.join("outputs/manifests");
    secure_fs::create_private_dir_all(&manifests)?;
    std::fs::write(
        manifests.join(format!("{id}.json")),
        serde_json::to_vec(&json!({
            "kind":"site", "output_id":id, "session_id":session, "message_id":slot,
            "turn_id":slot, "title":"Seeded output", "revisions":[{"revision":1,
            "entry":"index.html", "files":{"index.html":sha}, "size_bytes":body.len(),
            "created_at":"2026-01-01T00:00:00Z"}]
        }))?,
    )?;
    let markers = data.join("outputs/sessions").join(hash(session.as_bytes()));
    secure_fs::create_private_dir_all(&markers)?;
    std::fs::write(markers.join(&id), [])?;
    let db = db(data)?;
    db.execute(
        "INSERT INTO outputs VALUES(?1,?2,?3,?3,'Seeded output',?4,'2026-01-01')",
        params![id, session, slot, body.len()],
    )?;
    db.execute(
        "INSERT INTO output_refs VALUES(?1,?2,?3,?3)",
        params![id, session, slot],
    )?;
    if indexed {
        db.execute(
            "INSERT INTO output_blobs(sha,output_id) VALUES(?1,?2)",
            params![sha, id],
        )?;
    }
    Ok(id)
}
fn scalar(data: &Path, sql: &str) -> Result<i64, HarnessError> {
    Ok(db(data)?.query_row(sql, [], |r| r.get(0))?)
}
async fn completed(s: &Scenario) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let ready = scalar(
                &s.sandbox.data,
                "SELECT complete FROM output_blob_backfill WHERE id=1",
            )? != 0;
            // Completion commits before the durable queue drains.
            if ready && scalar(&s.sandbox.data, "SELECT count(*) FROM output_blob_sweep")? == 0 {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| HarnessError("backfill or sweep did not complete".into()))?
}
async fn chat(s: &Scenario) -> Result<String, HarnessError> {
    let r = s.gw.post("/sessions", json!({"kind":"chat"})).await?;
    assert_eq!(r.status, 201, "{r:?}");
    Ok(r.data()["session"]["id"].as_str().unwrap().to_owned())
}
async fn delete(s: &Scenario, session: &str) -> Result<(), HarnessError> {
    let r =
        s.gw.delete(&format!("/sessions/{session}?permanent=true"))
            .await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(())
}
async fn content(s: &Scenario, id: &str, expected: &str) -> Result<(), HarnessError> {
    let view = s.gw.get(&format!("/outputs/{id}/view")).await?;
    assert_eq!(view.status, 200, "{view:?}");
    assert_eq!(
        reqwest::get(view.data()["url"].as_str().unwrap())
            .await?
            .text()
            .await?,
        expected
    );
    Ok(())
}
fn block_completion(data: &Path) -> Result<(), HarnessError> {
    db(data)?.execute_batch("CREATE TRIGGER block_complete BEFORE UPDATE OF complete ON output_blob_backfill WHEN NEW.complete=1 BEGIN SELECT RAISE(ABORT,'hold backfill'); END;")?;
    Ok(())
}
struct Unreadable(PathBuf, Option<secure_fs::FileMode>);
impl Unreadable {
    fn directory(path: PathBuf) -> Result<Self, HarnessError> {
        secure_fs::create_private_dir_all(&path)?;
        let original = secure_fs::file_mode(&secure_fs::current_metadata(&path)?);
        if let Some(result) = secure_fs::set_file_mode(&path, secure_fs::FileMode::from_bits(0)) {
            result?;
        }
        Ok(Self(path, original))
    }
}
impl Drop for Unreadable {
    fn drop(&mut self) {
        let Some(mode) = self.1 else {
            return;
        };
        if let Some(Err(error)) = secure_fs::set_file_mode(&self.0, mode)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("restore fixture permission: {error}");
        }
    }
}
