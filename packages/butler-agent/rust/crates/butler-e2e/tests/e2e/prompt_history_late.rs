//! Completion order follows immutable terminal-message sequence without new turn state.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]

use super::{prefix, provider, source};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use rusqlite::Connection;
use serde_json::json;

#[tokio::test]
async fn late_terminal_message_is_appended_with_identity_and_timestamp() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, stub, server) = provider::start(false).await?;
    let s = Setup::new("PROMPT-LATE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
        .start()
        .await?;
    s.turn("general", "first ordinary request").await?;
    let db = Connection::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    seed_late(&db)?;
    for index in 0..6 {
        s.turn("general", &format!("ordinary request {index}"))
            .await?;
    }
    let previous = prefix(stub.requests.lock().unwrap().last().unwrap());
    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    complete_late(&db, &timestamp)?;
    db.execute(
        "UPDATE conversation_turns SET status='complete',completed_at=?1 WHERE id='ct_late'",
        [&timestamp],
    )?;
    s.turn("general", "after late completion").await?;
    let requests = stub.requests.lock().unwrap().clone();
    let request = requests.last().unwrap();
    assert!(prefix(request).starts_with(&previous));
    let text = source(request);
    assert!(text.contains(&format!(
        "turn ct_late status complete completed {timestamp}"
    )));
    assert!(text.find("ordinary request 5").unwrap() < text.find("late user request").unwrap());
    assert!(text.contains("butler: late final reply"));
    db.execute(
        "UPDATE conversation_turns SET completed_at='2099-01-01T00:00:00Z' WHERE id='ct_late'",
        [],
    )?;
    s.turn("general", "after resumed completion").await?;
    let requests = stub.requests.lock().unwrap().clone();
    let resumed = requests.last().unwrap();
    assert!(
        source(resumed).contains("turn ct_late status complete completed 2099-01-01T00:00:00Z")
    );
    assert!(
        source(resumed).find("ordinary request 5").unwrap()
            < source(resumed).find("late user request").unwrap()
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn seed_late(db: &Connection) -> Result<(), HarnessError> {
    let session: String =
        db.query_row("SELECT id FROM conversation_sessions LIMIT 1", [], |row| {
            row.get(0)
        })?;
    let turn_seq: u64 = db.query_row("SELECT MAX(seq)+1 FROM conversation_turns", [], |row| {
        row.get(0)
    })?;
    let seq: u64 = db.query_row("SELECT MAX(seq)+1 FROM conversation_messages", [], |row| {
        row.get(0)
    })?;
    db.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at) VALUES('ct_late',?1,?2,'user','running','2026-01-01T00:00:00Z')", rusqlite::params![session,turn_seq])?;
    let id = "cm_late_0";
    db.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES(?1,?2,'ct_late',?3,'user','complete','user','imported','2026-01-01T00:00:00Z')", rusqlite::params![id,session,seq])?;
    db.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES('cp_late_0',?1,0,'text',?2,'complete')", rusqlite::params![id,json!({"text":"late user request"}).to_string()])?;
    Ok(())
}

fn complete_late(db: &Connection, timestamp: &str) -> Result<(), HarnessError> {
    let session: String = db.query_row(
        "SELECT session_id FROM conversation_turns WHERE id='ct_late'",
        [],
        |row| row.get(0),
    )?;
    let seq: u64 = db.query_row("SELECT MAX(seq)+1 FROM conversation_messages", [], |row| {
        row.get(0)
    })?;
    db.execute("INSERT INTO conversation_messages(id,session_id,turn_id,seq,role,status,visibility,provenance,created_at) VALUES('cm_late_1',?1,'ct_late',?2,'assistant','complete','user','imported',?3)", rusqlite::params![session,seq,timestamp])?;
    db.execute("INSERT INTO conversation_parts(id,message_id,part_index,kind,content_json,status) VALUES('cp_late_1','cm_late_1',0,'text',?1,'complete')", [json!({"text":"late final reply"}).to_string()])?;
    Ok(())
}
