//! A pinned read mark misses reset without forcing a retry or background chain.
use super::*;

static RELEASE_READER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn pause_completed_pass(event: sqlite::CheckpointEvent) {
    if matches!(event, sqlite::CheckpointEvent::WalCommitted(_))
        && RELEASE_READER.swap(false, SeqCst)
    {
        READER.with(|reader| {
            reader
                .borrow_mut()
                .take()
                .unwrap()
                .execute_batch("ROLLBACK")
                .unwrap();
        });
        observe(event);
    } else {
        current_reader::pin_current_snapshot(event);
    }
    if matches!(event, sqlite::CheckpointEvent::Finished { .. }) {
        let pause = PAUSE.lock().unwrap().take();
        if let Some((arrived, resume)) = pause {
            arrived.send(()).unwrap();
            let _ = resume.recv();
        }
    }
}

fn pause_next_pass() -> (mpsc::Receiver<()>, mpsc::SyncSender<()>) {
    let (arrived, paused) = mpsc::sync_channel(1);
    let (resume, release) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, release));
    (paused, resume)
}

// test-category: race
#[test]
fn pinned_finish_runs_once_and_next_threshold_cycle_retries()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    FINISHES.store(0, SeqCst);
    PASSES.store(0, SeqCst);
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (first, resume) = pause_next_pass();
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_completed_pass))
        .unwrap()
        .unwrap();
    let release = resume;
    store.insert_many(1100);
    first.recv().unwrap();
    let (initial, done) = frames(&store.path);
    assert_eq!(initial, done);
    store.insert();
    assert_eq!(FINISHES.load(SeqCst), 1);
    let (finished, done) = frames(&store.path);
    assert!(finished > initial);
    assert_eq!(finished, done);
    store.insert();
    let (tail, _) = frames(&store.path);
    assert!(tail > finished, "reader mark must prevent reset");
    assert_eq!(FINISHES.load(SeqCst), 1, "finish must not loop");
    let mut count = 1102;
    while frames(&store.path).0 - finished < 1000 {
        store.insert();
        count += 1;
    }
    let (second, resume) = pause_next_pass();
    release.send(()).unwrap();
    let release = resume;
    second.recv().unwrap();
    assert_eq!(PASSES.load(SeqCst), 2);
    RELEASE_READER.store(true, SeqCst);
    store.insert();
    count += 1;
    assert_eq!(FINISHES.load(SeqCst), 2);
    store.reset_after_quiet();
    count += 1;
    assert_eq!(FINISHES.load(SeqCst), 2);
    release.send(()).unwrap();
    owner.close().unwrap();
    store.counts(count);
    eprintln!(
        "pinned finish: background=2 finish=2 reset_frames={}",
        frames(&store.path).0
    );
    Ok(())
}

// test-category: race
#[test]
fn raced_background_snapshot_waits_for_next_commit_to_finish()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    PASSES.store(0, SeqCst);
    FINISHES.store(0, SeqCst);
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (arrived, backfilled) = mpsc::sync_channel(1);
    let (resume, paused) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, paused));
    let owner =
        sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_before_finish_pending))
            .unwrap()
            .unwrap();
    // Drop the sender before the owner on panic, so joining cannot deadlock.
    let release = resume;
    store.insert_many(2000);
    backfilled.recv().unwrap();
    let (log, done) = frames(&store.path);
    assert!(log >= 1000);
    assert_eq!(done, log);
    // The pinned snapshot prevents reset; releasing it leaves one small tail.
    store.insert();
    let (tail, _) = frames(&store.path);
    assert!(tail > log && tail - log < 1000);
    READER.with(|reader| {
        assert!(reader.borrow_mut().take().unwrap().is_autocommit());
    });
    let (finished, completion) = mpsc::sync_channel(1);
    *FINISHED.lock().unwrap() = Some(finished);
    release.send(()).unwrap();
    completion.recv().unwrap();
    assert_eq!(PASSES.load(SeqCst), 1, "background must not chain");
    // A commit before finish_pending is published cannot consume it. With no
    // timer or chain, one more commit is required to backfill this quiet tail.
    assert_eq!(frames(&store.path), (tail, log), "no commit, no finish");
    store.insert();
    assert_eq!(FINISHES.load(SeqCst), 1);
    let (tail, backfilled) = frames(&store.path);
    assert_eq!(backfilled, tail);
    store.reset_after_quiet();
    assert_eq!(FINISHES.load(SeqCst), 1);
    owner.close().unwrap();
    store.counts(2003);
    eprintln!("small final commit: before={log} after={tail} backfilled={backfilled}");
    Ok(())
}
