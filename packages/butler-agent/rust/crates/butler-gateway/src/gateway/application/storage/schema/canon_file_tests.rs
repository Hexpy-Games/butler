use crate::gateway::application::{canon::files, storage};
use rusqlite::Connection;
const FILE: &str = "file-00000000-0000-0000-0000-000000000001";
fn db() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    super::migrate(&mut db, None).unwrap();
    db.execute("INSERT INTO message_files(id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at)
      VALUES(?1,'image','image/png','image.png',1,'sha',?1,'now')", [FILE]).unwrap();
    db
}
// Deterministic interleaving between pending-write pins, relay and cleanup.
// test-category: race
#[test]
fn sweep_rechecks_a_concurrent_new_reference() {
    let path =
        std::env::temp_dir().join(format!("canon-file-race-{}.sqlite", uuid::Uuid::new_v4()));
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    super::migrate(&mut db, None).unwrap();
    db.execute("INSERT INTO message_files(id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at)
      VALUES(?1,'image','image/png','image.png',1,'sha',?1,'now')",[FILE]).unwrap();
    files::replace(
        &db,
        &serde_json::json!({"kind":"work","id":"first","attachments":[FILE]}),
    )
    .unwrap();
    files::replace(
        &db,
        &serde_json::json!({"kind":"work","id":"first","attachments":[]}),
    )
    .unwrap();
    let (selected, selection) = std::sync::mpsc::channel();
    let (referenced, reference) = std::sync::mpsc::channel();
    let (resume, resumed) = std::sync::mpsc::channel();
    std::thread::scope(|threads| {
        let writer_path = &path;
        let writer = threads.spawn(move || {
            selection.recv().unwrap();
            let mut writer = Connection::open(writer_path).unwrap();
            writer.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            writer
                .execute("INSERT INTO app_file_pending VALUES(?1,'later')", [FILE])
                .unwrap();
            referenced.send(()).unwrap();
            resumed.recv().unwrap();
            let tx = writer.transaction().unwrap();
            files::replace(
                &tx,
                &serde_json::json!({"kind":"work","id":"second","attachments":[FILE]}),
            )
            .unwrap();
            tx.commit().unwrap();
            referenced.send(()).unwrap();
        });
        let queued: String = db
            .query_row(storage::schema::canon_files::SWEEP_QUEUE, [], |r| r.get(0))
            .unwrap();
        selected.send(()).unwrap();
        reference.recv().unwrap();
        assert_eq!(
            db.execute(storage::schema::canon_files::DELETE_UNUSED, [&queued])
                .unwrap(),
            0,
            "The pending write protects its file before relay commit"
        );
        resume.send(()).unwrap();
        reference.recv().unwrap();
        let tx = db.transaction().unwrap();
        assert_eq!(
            tx.execute(storage::schema::canon_files::DELETE_UNUSED, [queued])
                .unwrap(),
            0
        );
        tx.commit().unwrap();
        writer.join().unwrap();
    });
    assert_eq!(files::list(&db, "second").unwrap()[0]["file_id"], FILE);
    drop(db);
    std::fs::remove_file(path).unwrap();
}
// Pin the actual bounded queue scan and indexed reference/expiry operations.
// test-category: format-pin
#[test]
fn attachment_statements_use_keyed_and_expiry_indexes() {
    let db = db();
    use storage::schema::canon_files::{
        DELETE_EXPIRED, DELETE_PENDING, DELETE_UNUSED, EPIC_FILES, EXPIRED, PIN_PENDING,
        REMOVE_REFS, REMOVE_SWEEP, SWEEP_QUEUE,
    };
    for (sql, index) in [
        (EPIC_FILES, "sqlite_autoindex_app_canon_epic_files"),
        (EXPIRED, "app_file_pending_expiry"),
        (DELETE_EXPIRED, "app_file_pending_expiry"),
        (DELETE_UNUSED, "sqlite_autoindex_message_files"),
        (SWEEP_QUEUE, "sqlite_autoindex_app_file_sweep"),
        (REMOVE_SWEEP, "sqlite_autoindex_app_file_sweep"),
        (DELETE_PENDING, "sqlite_autoindex_app_file_pending"),
        (REMOVE_REFS, "sqlite_autoindex_app_canon_epic_files"),
        (PIN_PENDING, "app_canon_epic_files_file"),
    ] {
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let bindings = rusqlite::params_from_iter(std::iter::repeat_n(
            rusqlite::types::Value::Null,
            stmt.parameter_count(),
        ));
        let plan = stmt
            .query_map(bindings, |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(plan.contains(index), "{sql}: {plan}");
        assert!(
            !plan.lines().any(|line| line.contains("SCAN ")
                && !line.contains("json_each")
                && !line.contains("SCAN CONSTANT ROW")
                // This ordered scan is bounded to 100 pending deletions, not file history.
                && !(sql == SWEEP_QUEUE && line.contains("SCAN app_file_sweep USING COVERING INDEX"))),
            "{sql}: {plan}"
        );
    }
}
// Session ownership is part of the App file binding contract.
// test-category: security
#[test]
fn session_reference_helper_validates_ownership_and_deduplicates() {
    let db = db();
    db.execute("INSERT INTO chats(id,title,kind,created_at,updated_at) VALUES('chat','chat','chat','now','now')",[]).unwrap();
    db.execute(
        "UPDATE message_files SET owner_session_id='chat' WHERE id=?1",
        [FILE],
    )
    .unwrap();
    db.execute(
        "UPDATE chats SET runtime_session_hint='rotated-owner' WHERE id='chat'",
        [],
    )
    .unwrap();
    assert!(files::append_session_references(&db, "rotated-owner", "", &[FILE.into()]).is_err());
    assert!(files::append_session_references(&db, "other", "", &[FILE.into()]).is_err());
    let markdown =
        files::append_session_references(&db, "chat", "", &[FILE.into(), FILE.into()]).unwrap();
    assert_eq!(markdown, format!("\n![image.png](attachment:{FILE})"));
    for kind in ["text", "generic"] {
        db.execute(
            "UPDATE message_files SET kind=?1,safe_name=?2 WHERE id=?3",
            rusqlite::params![kind, "[notes]\\draft\n.txt", FILE],
        )
        .unwrap();
        let markdown = files::append_session_references(&db, "chat", "", &[FILE.into()]).unwrap();
        assert_eq!(
            markdown,
            format!("\n[\\[notes\\]\\\\draft .txt](attachment:{FILE})")
        );
        assert_eq!(
            butler_canon::store::attachment_references(&markdown).unwrap(),
            vec![FILE]
        );
    }
}
