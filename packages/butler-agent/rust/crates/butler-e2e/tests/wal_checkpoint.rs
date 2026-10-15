//! Storage regressions for coalesced maintenance, using real SQLite connections.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]
use butler_platform::{process_control::sample_usage, sqlite};
use std::{
    cell::RefCell,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicI32, AtomicU64, AtomicUsize, Ordering::SeqCst},
        mpsc,
    },
    thread::sleep,
    time::Duration,
};

const JOURNAL_LIMIT: u64 = 16_777_216;

static SERIAL: Mutex<()> = Mutex::new(());
static LAST: AtomicI32 = AtomicI32::new(0);
static MAX: AtomicI32 = AtomicI32::new(0);
static RESTARTS: AtomicUsize = AtomicUsize::new(0);
static PASSES: AtomicUsize = AtomicUsize::new(0);
static MAX_PASS_US: AtomicU64 = AtomicU64::new(0);
type Pause = (mpsc::SyncSender<()>, mpsc::Receiver<()>);
static PAUSE: Mutex<Option<Pause>> = Mutex::new(None);
thread_local! {
    static READER: RefCell<Option<sqlite::Connection>> = const { RefCell::new(None) };
}

fn pause_after_backfill(event: sqlite::CheckpointEvent) {
    if matches!(event, sqlite::CheckpointEvent::WalCommitted(_)) {
        // The hook runs after COMMIT and before requesting maintenance. Pin
        // the first snapshot: PASSIVE can finish, but the writer cannot reset.
        READER.with(|reader| {
            let reader = reader.borrow();
            let reader = reader.as_ref().unwrap();
            if reader.is_autocommit() {
                reader
                    .execute_batch("BEGIN; SELECT id FROM t LIMIT 1;")
                    .unwrap();
            }
        });
    }
    let pause = if matches!(event, sqlite::CheckpointEvent::Finished { .. }) {
        PAUSE.lock().unwrap().take()
    } else {
        None
    };
    observe(event);
    if let Some((arrived, resume)) = pause {
        arrived.send(()).unwrap();
        // Dropping the sender also releases maintenance on an assertion panic.
        let _ = resume.recv();
    }
}

fn observe(event: sqlite::CheckpointEvent) {
    match event {
        sqlite::CheckpointEvent::WalCommitted(pages) => {
            if pages < LAST.swap(pages, SeqCst) {
                RESTARTS.fetch_add(1, SeqCst);
            }
            MAX.fetch_max(pages, SeqCst);
        }
        sqlite::CheckpointEvent::Finished { succeeded, elapsed } => {
            assert!(succeeded);
            MAX_PASS_US.fetch_max(u64::try_from(elapsed.as_micros()).unwrap(), SeqCst);
            if elapsed > Duration::from_millis(300) {
                eprintln!(
                    "background pass elapsed={elapsed:?} last_commit={}",
                    LAST.load(SeqCst)
                );
            }
            PASSES.fetch_add(1, SeqCst);
        }
    }
}

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Store {
    db: sqlite::Connection,
    path: PathBuf,
    _directory: Directory,
}
impl Store {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("wal-checkpoint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("store.sqlite");
        let db = sqlite::open(&path).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            PRAGMA journal_size_limit=16777216; PRAGMA wal_autocheckpoint=1000;
            CREATE TABLE t(id INTEGER PRIMARY KEY, v BLOB)",
        )
        .unwrap();
        Self {
            db,
            path,
            _directory: Directory(directory),
        }
    }
    fn bytes(&self) -> u64 {
        std::fs::metadata(self.path.with_extension("sqlite-wal"))
            .unwrap()
            .len()
    }
    fn insert(&self) {
        let previous = LAST.load(SeqCst);
        self.db
            .execute("INSERT INTO t(v) VALUES(zeroblob(3000))", [])
            .unwrap();
        if LAST.load(SeqCst) < previous {
            // journal_size_limit applies at reset, not while frames accumulate.
            // This fixture's individual transactions are smaller than the limit.
            assert!(
                self.bytes() <= JOURNAL_LIMIT,
                "reset did not shrink the WAL"
            );
        }
    }
    fn reset_after_quiet(&self) {
        let (log, done) = frames(&self.path);
        assert_eq!(done, log, "quiet tail was stranded after the last request");
        let retained = self.bytes();
        self.insert();
        let (reset, _) = frames(&self.path);
        assert!(reset < log, "first write after backfill did not reset WAL");
        assert!(
            self.bytes() <= JOURNAL_LIMIT,
            "reset did not shrink the WAL"
        );
        eprintln!(
            "quiet WAL: frames={log} backfilled={done} retained_bytes={retained} \
             reset_frames={reset} reset_bytes={}",
            self.bytes()
        );
    }
    fn worker(&self) -> sqlite::CheckpointOwner {
        // A custom wal_hook replaces SQLite's autocheckpoint hook. Reinstall
        // the configured threshold before starting another maintenance owner.
        self.db
            .pragma_update(None, "wal_autocheckpoint", 1000)
            .unwrap();
        sqlite::CheckpointOwner::start(&self.db, Some(observe))
            .unwrap()
            .unwrap()
    }
    fn insert_many(&self, count: i64) {
        self.db
            .execute(
                "WITH RECURSIVE ids(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM ids WHERE x<?1)
             INSERT INTO t(v) SELECT zeroblob(3000) FROM ids",
                [count],
            )
            .unwrap();
    }
    fn counts(&self, expected: i64) {
        let counts: (i64, i64, i64, i64) = self
            .db
            .query_row(
                "SELECT count(*),min(id),max(id),sum(v=zeroblob(3000)) FROM t",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(counts, (expected, 1, expected, expected));
    }
}
// Read SQLite's native-endian WAL-index header, without running a checkpoint
// that would repair the bug under test. mxFrame is at 16; nBackfill at 96.
fn frames(path: &Path) -> (u32, u32) {
    let mut header = [0; 100];
    File::open(path.with_extension("sqlite-shm"))
        .unwrap()
        .read_exact(&mut header)
        .unwrap();
    (
        u32::from_ne_bytes(header[16..20].try_into().unwrap()),
        u32::from_ne_bytes(header[96..100].try_into().unwrap()),
    )
}

// test-category: race
#[test]
fn bursts_restart_bound_wal_and_leave_zero_idle_checkpoint_writes()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    // Isolate process I/O from other tests and libtest's parallel timeout logs.
    if std::env::var_os("BUTLER_WAL_BURST_CHILD").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "bursts_restart_bound_wal_and_leave_zero_idle_checkpoint_writes",
                "--test-threads=1",
                "--nocapture",
            ])
            .env("BUTLER_WAL_BURST_CHILD", "1")
            .output()
            .unwrap();
        eprint!("{}", String::from_utf8_lossy(&output.stderr));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        return Ok(());
    }
    let _serial = SERIAL.lock().unwrap();
    LAST.store(0, SeqCst);
    MAX.store(0, SeqCst);
    RESTARTS.store(0, SeqCst);
    PASSES.store(0, SeqCst);
    MAX_PASS_US.store(0, SeqCst);
    let store = Store::new();
    let owner = store.worker();
    let mut largest = 0;
    let mut committed = 0;
    for _ in 0..100 {
        for _ in 0..200 {
            store.insert();
            committed += 1;
        }
        sleep(Duration::from_millis(300));
        largest = largest.max(store.bytes());
    }
    store.counts(committed);
    eprintln!(
        "WAL bursts: commits={committed} max_frames={} restarts={} max_bytes={largest} final_bytes={}",
        MAX.load(SeqCst),
        RESTARTS.load(SeqCst),
        store.bytes()
    );
    // SQLite limits retained space when a WAL resets, not the active frame
    // span. A slow PASSIVE checkpoint may span the entire burst workload;
    // require restart after draining, not within the fixed quiet gaps. Even a
    // complete backfill keeps the file until the next writer resets it.
    // https://www.sqlite.org/pragma.html#pragma_journal_size_limit
    // https://www.sqlite.org/c3ref/wal_checkpoint_v2.html
    // insert() checks every observed reset. Keep the peak as diagnostic evidence
    // and require full quiet-tail backfill plus reset below, without issuing a
    // checkpoint from the test (which could hide a stranded-tail regression).
    let page_size: u64 = store
        .db
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .unwrap();
    let peak_span = 32 + u64::try_from(MAX.load(SeqCst)).unwrap() * (page_size + 24);
    eprintln!("peak committed WAL span: {peak_span} bytes");

    // End above threshold, so the last quiet period must fully backfill.
    while LAST.load(SeqCst) < 1000 {
        store.insert();
        committed += 1;
    }
    // Close only drains requests already sent by commits; it never requests a
    // final pass. The maintenance connection disables checkpoint-on-close, so
    // this completion barrier cannot repair a stranded tail for the test.
    owner.close().unwrap();
    let (log, done) = frames(&store.path);
    assert_eq!(done, log, "quiet tail was stranded after the last request");
    eprintln!("maximum background pass: {} us", MAX_PASS_US.load(SeqCst));
    let idle_owner = store.worker();
    let passes = PASSES.load(SeqCst);
    let bytes = store.bytes();
    let before = sample_usage(std::process::id()).unwrap().unwrap();
    sleep(Duration::from_secs(60));
    let after = sample_usage(std::process::id()).unwrap().unwrap();
    assert_eq!(PASSES.load(SeqCst), passes);
    assert_eq!(store.bytes(), bytes);
    assert_eq!(after.write_chars, before.write_chars);
    assert_eq!(after.write_bytes, before.write_bytes);
    eprintln!(
        "idle 60s: checkpoint_passes=0 write_chars={:?} write_bytes={}",
        after
            .write_chars
            .zip(before.write_chars)
            .map(|(a, b)| a - b),
        after.write_bytes - before.write_bytes
    );
    idle_owner.close().unwrap();
    // Keep the reset probe's new write outside the drained idle observation.
    store.reset_after_quiet();
    committed += 1;
    store.counts(committed);
    Ok(())
}

// test-category: race
#[test]
fn pinned_reader_stops_partial_passes_until_another_commit()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    PASSES.store(0, SeqCst);
    MAX_PASS_US.store(0, SeqCst);
    let store = Store::new();
    let reader = sqlite::open(&store.path).unwrap();
    reader.execute_batch("BEGIN; SELECT * FROM t;").unwrap();
    let owner = store.worker();
    for _ in 0..2000 {
        store.insert();
    }
    // Draining must terminate even while the reader keeps a partial backfill.
    owner.close().unwrap();
    let (log, done) = frames(&store.path);
    assert!(done < log);
    assert!(PASSES.load(SeqCst) > 0);
    assert!(
        store.bytes() > JOURNAL_LIMIT,
        "reader did not pin an oversized WAL"
    );
    reader.execute_batch("ROLLBACK").unwrap();
    let owner = store.worker();
    store.insert();
    owner.close().unwrap();
    // PASSIVE can backfill everything without truncating the retained tail.
    // Only the next writer resets it and applies journal_size_limit.
    assert!(store.bytes() > JOURNAL_LIMIT);
    store.reset_after_quiet();
    store.counts(2002);
    Ok(())
}

// test-category: race
#[test]
fn final_small_commit_after_backfill_cannot_strand_a_wal_tail()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (arrived, backfilled) = mpsc::sync_channel(1);
    let (resume, paused) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, paused));
    let owner = sqlite::CheckpointOwner::start(&store.db, Some(pause_after_backfill))
        .unwrap()
        .unwrap();
    // Drop the sender before the owner on panic, so joining cannot deadlock.
    let release = resume;
    store.insert_many(2000);
    backfilled.recv().unwrap();
    let (log, done) = frames(&store.path);
    assert!(log >= 1000);
    assert_eq!(done, log);
    // Keep the reader pinned while appending a sub-threshold tail. A moving
    // wake threshold would not enqueue this commit, even though WAL >= 1000.
    store.insert();
    let (tail, _) = frames(&store.path);
    assert!(tail > log && tail - log < 1000);
    READER.with(|reader| {
        reader
            .borrow_mut()
            .take()
            .unwrap()
            .execute_batch("ROLLBACK")
            .unwrap();
    });
    release.send(()).unwrap();
    owner.close().unwrap();
    store.reset_after_quiet();
    store.counts(2002);
    eprintln!("final small commit: before={log} after={tail} backfilled={tail}");
    Ok(())
}

// test-category: race
#[test]
fn checkpoint_failure_still_releases_btcc_owner_and_syncs_wal()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    let fixture = butler_turn::btcc::TestStorageFixture::activated();
    let (result, status, retained) = fixture.close_after_checkpoint_panic();
    let error = result.unwrap_err();
    assert_eq!(
        error.code(),
        butler_turn::btcc::StorageCode::SqliteWalSyncFailed.as_str()
    );
    assert!(error.message().contains("Checkpoint worker panicked"));
    assert_eq!(status, "closed");
    assert!(retained > 0, "explicit close must retain the synced WAL");
    Ok(())
}
