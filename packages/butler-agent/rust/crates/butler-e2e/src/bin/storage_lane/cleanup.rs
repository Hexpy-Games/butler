//! Ordered cleanup replacement against the real migrated App store.
use super::*;

pub(super) fn run(path: &Path) {
    // A deployed cleanup table must migrate without losing pending debt.
    Connection::open(path).unwrap().execute_batch(
        "CREATE TABLE app_session_delete_cleanups(session_id TEXT PRIMARY KEY,kind TEXT NOT NULL,session_hint TEXT);
         INSERT INTO app_session_delete_cleanups VALUES('legacy','archive',NULL);",
    ).unwrap();
    let (write, completed) = Operation::new(false, false, |db| {
        assert_eq!(
            db.query_row(
                "SELECT kind FROM app_session_delete_cleanups WHERE session_id='legacy'",
                [],
                |r| r.get::<_, String>(0)
            )?,
            "archive"
        );
        assert_eq!(
            db.query_row(
                "SELECT generation FROM app_session_delete_cleanups WHERE session_id='legacy'",
                [],
                |r| r.get::<_, i64>(0)
            )?,
            0
        );
        for original_kind in ["archive", "delete"] {
            db.execute(
                "INSERT INTO app_session_delete_cleanups(session_id,kind) VALUES(?1,?2)",
                rusqlite::params![original_kind, original_kind],
            )?;
            let (kind, generation): (String, i64) = db.query_row(
                "SELECT kind,generation FROM app_session_delete_cleanups WHERE session_id=?1",
                [original_kind],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            // Project deletion replaces the record after cleanup has read it.
            storage_testing::record_session_delete_cleanup(db, original_kind, "new-runtime-hint")
                .unwrap();
            assert_eq!(
                storage_testing::clear_session_cleanup(db, original_kind, &kind, generation)
                    .unwrap(),
                0,
                "stale {kind} acknowledgment erased newer delete debt"
            );
            let record: (String, String) = db.query_row(
                "SELECT kind,session_hint FROM app_session_delete_cleanups WHERE session_id=?1",
                [original_kind],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(record, ("delete".into(), "new-runtime-hint".into()));
            let latest: i64 = db.query_row(
                "SELECT generation FROM app_session_delete_cleanups WHERE session_id=?1",
                [original_kind],
                |r| r.get(0),
            )?;
            assert_eq!(latest, generation + 1);
            assert_eq!(
                storage_testing::clear_session_cleanup(db, original_kind, "delete", latest)
                    .unwrap(),
                1
            );
            assert_eq!(
                storage_testing::clear_session_cleanup(db, original_kind, "delete", latest)
                    .unwrap(),
                0
            );
        }
        Ok(())
    });
    let (sender, thread) = storage_testing::start(path.to_owned(), vec![write]).unwrap();
    completed.wait().unwrap();
    drop(sender);
    thread.join().unwrap().unwrap();
}
