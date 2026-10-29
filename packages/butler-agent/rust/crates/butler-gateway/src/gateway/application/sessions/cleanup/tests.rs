// test-category: race
//! Ordered store operations reproduce an archive overtaken by project deletion.
use super::*;

#[test]
fn archive_clear_preserves_project_delete_record() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE app_session_delete_cleanups(session_id TEXT PRIMARY KEY,kind TEXT NOT NULL,session_hint TEXT);
         INSERT INTO app_session_delete_cleanups VALUES('chat','archive',NULL);",
    ).unwrap();
    let read_kind: String = db
        .query_row(
            "SELECT kind FROM app_session_delete_cleanups WHERE session_id='chat'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(read_kind, "archive");
    // Project deletion commits while archive cleanup holds its session lock.
    db.execute(
        "INSERT INTO app_session_delete_cleanups VALUES('chat','delete','runtime-hint')
         ON CONFLICT(session_id) DO UPDATE SET kind='delete',session_hint=excluded.session_hint",
        [],
    )
    .unwrap();
    let cleared = clear_record_in(&db, "chat").unwrap();
    assert_eq!(cleared, 0, "archive must not acknowledge newer delete debt");
    let record: (String, String) = db
        .query_row(
            "SELECT kind,session_hint FROM app_session_delete_cleanups WHERE session_id='chat'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(record, ("delete".into(), "runtime-hint".into()));
    assert_eq!(clear_record_in(&db, "chat").unwrap(), 1);
}
