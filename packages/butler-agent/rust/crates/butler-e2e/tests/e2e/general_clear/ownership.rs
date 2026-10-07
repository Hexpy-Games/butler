//! Extent ownership survives restart, empty clears, deletion and SQLite rowid reuse.
use butler_e2e::e2e::{
    HarnessError, fixtures,
    scenario::{Fixture, Scenario, Setup},
};
use butler_platform::sqlite;
use serde_json::json;

#[tokio::test]
async fn general_clear_extent_is_atomic_and_does_not_capture_reused_rowids()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("GENERAL-CLEAR-EXTENT")?.fixture(Fixture::Empty);
    fixtures::onboarding_complete(&setup.sandbox.data)?;
    fixtures::scheduler_ran_today(&setup.sandbox.data, fixtures::FIXTURE_TIME)?;
    let mut s = setup.start().await?;
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    db.execute_batch("INSERT INTO chats(id,title,kind,archived,created_at,updated_at) VALUES('other','Other','chat',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
      INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('old','general','user','Old history','delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('foreign','other','user','Foreign history','delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');")?;
    db.execute_batch("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000) INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) SELECT 'foreign-'||i,'other','user','Foreign history','delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM n")?;
    assert_scoped_cursor_work(&db)?;
    drop(db);
    s.gw = s.agent.start_again().await?;
    let snapshot = sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    snapshot.execute_batch("BEGIN")?;
    assert_eq!(
        super::support::ordered_message_ids(&snapshot, "general")?,
        vec!["old"]
    );
    let archive = clear(&s, "Old General").await?;
    assert_eq!(
        super::support::ordered_message_ids(&snapshot, "general")?,
        vec!["old"]
    );
    assert!(super::support::ordered_message_ids(&snapshot, &archive)?.is_empty());
    snapshot.execute_batch("COMMIT")?;
    assert!(super::support::ordered_message_ids(&snapshot, "general")?.is_empty());
    assert_eq!(
        super::support::ordered_message_ids(&snapshot, &archive)?,
        vec!["old"]
    );
    drop(snapshot);
    assert_eq!(s.gw.messages(&archive).await?[0]["id"], "old");
    assert!(s.gw.messages("general").await?.is_empty());
    let empty = clear(&s, "Empty General").await?;
    assert!(s.gw.messages(&empty).await?.is_empty());
    assert_eq!(
        s.gw.delete("/sessions/other?permanent=true").await?.status,
        200
    );
    assert_eq!(
        s.gw.delete(&format!("/sessions/{archive}?permanent=true"))
            .await?
            .status,
        200
    );
    s.agent.terminate().await?;
    let db = sqlite::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let removed: i64 = db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?;
    assert_eq!(removed, 0, "archive deletion removed its physical rows");
    let indexed: i64 = db.query_row("SELECT COUNT(*) FROM messages_fts", [], |r| r.get(0))?;
    assert_eq!(indexed, 0);
    db.execute("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES('fresh','general','user','Fresh history','delivered','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])?;
    let cursor: i64 = db.query_row("SELECT rowid FROM messages WHERE id='fresh'", [], |r| {
        r.get(0)
    })?;
    assert_eq!(cursor, 1, "SQLite reused a deleted physical rowid");
    drop(db);
    s.gw = s.agent.start_again().await?;
    assert_eq!(s.gw.messages("general").await?[0]["id"], "fresh");
    assert!(s.gw.messages(&empty).await?.is_empty());
    let fresh_archive = clear(&s, "Fresh General").await?;
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert!(s.gw.messages("general").await?.is_empty());
    assert_eq!(
        s.gw.messages(&fresh_archive).await?[0]["text"],
        "Fresh history"
    );
    s.finish().await
}

async fn clear(s: &Scenario, title: &str) -> Result<String, HarnessError> {
    let result =
        s.gw.post("/sessions/general/clear", json!({"title": title}))
            .await?;
    assert_eq!(result.status, 200, "{}", result.text);
    result.data()["archived_session"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| HarnessError("missing clear archive id".into()))
}

fn assert_scoped_cursor_work(db: &rusqlite::Connection) -> Result<(), HarnessError> {
    let mut query = db.prepare(
        "SELECT id FROM app_owned_messages WHERE chat_id='general' ORDER BY rowid DESC LIMIT 50",
    )?;
    let ids = query
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    assert_eq!(ids, vec!["old"]);
    let steps = query.get_status(rusqlite::StatementStatus::VmStep);
    eprintln!("GENERAL-CURSOR unrelated_messages=5001 vm_steps={steps}");
    assert!(
        steps < 1000,
        "General cursor scanned unrelated history: {steps} VM steps"
    );
    Ok(())
}
