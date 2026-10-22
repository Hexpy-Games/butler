//! WAL backup must make progress while another SQLite connection commits.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]
use butler_work::cutover::{self, CutoverState};
use rusqlite::Connection;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

// test-category: race
#[test]
fn wal_backup_finishes_once_with_a_consistent_snapshot() -> Result<(), butler_e2e::e2e::HarnessError>
{
    butler_e2e::gate!();
    let root = std::env::temp_dir().join(format!("wal-backup-{}", uuid::Uuid::new_v4()));
    for (folder, name) in [
        ("agent-runtime", "btcc.sqlite"),
        ("app-server", "butler-client.sqlite"),
    ] {
        std::fs::create_dir_all(root.join(folder))?;
        let db = Connection::open(root.join(folder).join(name))?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE original(id INTEGER PRIMARY KEY, payload BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<8192) INSERT INTO original SELECT x,zeroblob(4096) FROM n;")?;
    }
    let (request, requests) = mpsc::channel();
    let (committed, commits) = mpsc::channel();
    let path = root.join("agent-runtime/btcc.sqlite");
    let writer = std::thread::spawn(move || {
        let db = Connection::open(path).unwrap();
        let mut count = 0;
        loop {
            let requested = match requests.recv_timeout(Duration::from_millis(1)) {
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => false,
                Ok(()) => true,
            };
            db.execute(
                "UPDATE original SET payload=randomblob(4096) WHERE id=1",
                [],
            )
            .unwrap();
            count += 1;
            if requested {
                committed.send(()).unwrap();
            }
        }
        count
    });
    let source_bytes = std::fs::metadata(root.join("agent-runtime/btcc.sqlite"))?.len();
    let started = Instant::now();
    let result = cutover::prepare_with_cancel(&root, &|| {
        // Every batch boundary sees a commit, reproducing SQLite's restart
        // behavior deterministically. Hashing a finished target needs no barrier;
        // the writer continues committing independently during copy and hash.
        let copying = std::fs::read_dir(root.join("backups/work-model-cutover"))
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .any(|entry| {
                std::fs::metadata(entry.path().join("btcc.sqlite"))
                    .is_ok_and(|m| m.len() < source_bytes)
            });
        if copying {
            request.send(()).unwrap();
            commits.recv().unwrap();
        }
        started.elapsed() > Duration::from_secs(10)
    });
    drop(request);
    let writes = writer.join().unwrap();
    assert_eq!(result.unwrap(), CutoverState::Importing);
    assert!(writes > 1);
    let sets = std::fs::read_dir(root.join("backups/work-model-cutover"))?
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(sets.len(), 1);
    assert!(cutover::valid(&sets[0])?);
    for name in ["btcc.sqlite", "butler-client.sqlite"] {
        let db = Connection::open(sets[0].join(name))?;
        assert_eq!(
            db.query_row::<String, _, _>("PRAGMA integrity_check", [], |r| r.get(0))?,
            "ok"
        );
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT count(*) FROM original", [], |r| r.get(0))?,
            8192
        );
    }
    eprintln!(
        "WAL backup: {writes} concurrent commits, {:?}",
        started.elapsed()
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}
