//! Deterministically hold maintenance behind a pinned-reader burst.
use super::*;

static INLINE: AtomicUsize = AtomicUsize::new(0);
static MIN_INLINE_FRAMES: AtomicI32 = AtomicI32::new(i32::MAX);
static BACKGROUND: AtomicUsize = AtomicUsize::new(0);

fn pause_worker(event: sqlite::CheckpointEvent) {
    observe(event);
    if let sqlite::CheckpointEvent::Checkpointed { inline, frames, .. } = event {
        if inline {
            INLINE.fetch_add(1, SeqCst);
            MIN_INLINE_FRAMES.fetch_min(frames, SeqCst);
        } else {
            BACKGROUND.fetch_add(1, SeqCst);
        }
    }
    if matches!(event, sqlite::CheckpointEvent::Finished { .. }) {
        let pause = PAUSE.lock().unwrap().take();
        if let Some((arrived, resume)) = pause {
            arrived.send(()).unwrap();
            let _ = resume.recv();
        }
    }
}

// test-category: race
#[test]
fn stalled_worker_uses_inline_ceiling_and_recovers_after_reader_release()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    INLINE.store(0, SeqCst);
    BACKGROUND.store(0, SeqCst);
    MIN_INLINE_FRAMES.store(i32::MAX, SeqCst);
    let store = Store::new();
    let reader = sqlite::open(&store.path).unwrap();
    reader.execute_batch("BEGIN; SELECT * FROM t").unwrap();
    let (arrived, paused) = mpsc::sync_channel(1);
    let (resume, release) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, release));
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_worker))
        .unwrap()
        .unwrap();
    // Release maintenance before joining it even if an assertion panics.
    let release_worker = resume;
    store.insert_many(1100);
    paused.recv().unwrap();
    assert_eq!(BACKGROUND.load(SeqCst), 1);
    assert_eq!(INLINE.load(SeqCst), 0, "normal threshold delayed COMMIT");
    let mut committed = 1100;
    while LAST.load(SeqCst) < 4000 {
        store.insert();
        committed += 1;
    }
    assert!(
        INLINE.load(SeqCst) > 0,
        "backstop did not run at the ceiling"
    );
    assert!(MIN_INLINE_FRAMES.load(SeqCst) >= 4000);
    let (log, done) = frames(&store.path);
    assert!(
        done < log,
        "reader must pin the WAL even against a backstop"
    );
    reader.execute_batch("ROLLBACK").unwrap();
    // The worker is still paused: only the committing lane can backfill now.
    store.insert();
    committed += 1;
    let (log, done) = frames(&store.path);
    assert_eq!(
        done, log,
        "backstop failed to catch up after reader release"
    );
    let peak = store.bytes();
    assert!(
        peak <= JOURNAL_LIMIT,
        "small-transaction ceiling exceeded: {peak}"
    );
    store.insert();
    committed += 1;
    assert!(frames(&store.path).0 < 1000, "writer did not reset the WAL");
    store.counts(committed);
    eprintln!(
        "WAL backstop: commits={committed} inline={} min_inline_frames={} background={} peak_bytes={peak}",
        INLINE.load(SeqCst),
        MIN_INLINE_FRAMES.load(SeqCst),
        BACKGROUND.load(SeqCst)
    );
    release_worker.send(()).unwrap();
    owner.close().unwrap();
    Ok(())
}

// test-category: race
#[test]
fn reader_pinned_partial_pass_waits_for_a_threshold_of_new_frames()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    PASSES.store(0, SeqCst);
    let store = Store::new();
    let reader = sqlite::open(&store.path).unwrap();
    reader.execute_batch("BEGIN; SELECT * FROM t").unwrap();
    let (arrived, backfilled) = mpsc::sync_channel(1);
    let (resume, paused) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, paused));
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_worker))
        .unwrap()
        .unwrap();
    let release = resume;
    store.insert_many(1100);
    backfilled.recv().unwrap();
    let (log, done) = frames(&store.path);
    assert!(done < log);
    for _ in 0..100 {
        store.insert();
    }
    let (tail, _) = frames(&store.path);
    assert!(tail > log && tail - log < 1000);
    release.send(()).unwrap();
    owner.close().unwrap();
    assert_eq!(PASSES.load(SeqCst), 1, "partial pass retried small commits");
    assert_eq!(frames(&store.path), (tail, done));
    reader.execute_batch("ROLLBACK").unwrap();
    store.counts(1200);
    eprintln!("pinned subthreshold WAL: before={log} tail={tail} passes=1");
    Ok(())
}
