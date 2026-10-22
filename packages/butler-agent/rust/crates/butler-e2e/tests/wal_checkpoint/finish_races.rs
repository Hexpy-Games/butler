//! A stalled background finish cannot delay sub-ceiling writer commits.
use super::*;
use std::time::Instant;

fn run_race(pin_finish: bool) {
    let _serial = SERIAL.lock().unwrap();
    FINISHES.store(0, SeqCst);
    PASSES.store(0, SeqCst);
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (arrived, backfilled) = mpsc::sync_channel(1);
    let (resume, paused) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, paused));
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_after_backfill))
        .unwrap()
        .unwrap();
    let release = resume;
    owner.lane_busy();
    store.insert_many(1100);
    backfilled.recv_timeout(Duration::from_secs(5)).unwrap();
    let (log, done) = frames(&store.path);
    assert_eq!(log, done);
    store.insert();
    assert!(frames(&store.path).0 > log);
    READER.with(|reader| {
        assert!(reader.borrow_mut().take().unwrap().is_autocommit());
    });
    let (stalled, waiting) = mpsc::sync_channel(1);
    let (unstall, resume_finish) = mpsc::sync_channel(1);
    owner.stall_next_finish(move || {
        stalled.send(()).unwrap();
        let _ = resume_finish.recv();
    });
    // Declare after owner, so panic drops the release channel before joining.
    let release_finish = unstall;
    if pin_finish {
        // The finish can copy the tail, but this read mark prevents reset.
        let reader = sqlite::open(&store.path).unwrap();
        reader
            .execute_batch("BEGIN; SELECT * FROM t LIMIT 1")
            .unwrap();
        READER.with(|slot| *slot.borrow_mut() = Some(reader));
    }
    owner.lane_idle();
    release.send(()).unwrap();
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(FINISHES.load(SeqCst), 0);
    owner.lane_busy();
    let (committed, returned) = mpsc::sync_channel(1);
    let watchdog = std::thread::spawn(move || {
        let returned = returned.recv_timeout(Duration::from_secs(5)).is_ok();
        let _ = release_finish.send(());
        returned
    });
    let mut maximum = Duration::ZERO;
    for _ in 0..5 {
        let started = Instant::now();
        store.insert();
        maximum = maximum.max(started.elapsed());
        assert_eq!(FINISHES.load(SeqCst), 0, "finish released before commit");
    }
    let raced = frames(&store.path);
    if pin_finish {
        assert!(raced.0 > raced.1, "commits must race the finish's snapshot");
        READER.with(|reader| reader.borrow_mut().take());
    }
    let _ = committed.send(());
    assert!(watchdog.join().unwrap(), "commit waited for stalled finish");
    // Another idle report cannot re-arm a consumed finish, even for a raced tail.
    owner.lane_idle();
    owner.close().unwrap();
    assert_eq!(FINISHES.load(SeqCst), 1);
    assert_eq!(PASSES.load(SeqCst), 2, "one pass plus one finish, no chain");
    if pin_finish {
        assert_eq!(frames(&store.path), raced, "raced finish was re-armed");
    }
    store.counts(1106);
    eprintln!(
        "stalled finish: commits=5 max_commit_us={} pinned={pin_finish}",
        maximum.as_micros()
    );
}

// test-category: race
#[test]
fn stalled_finish_does_not_block_writer_commit() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    run_race(false);
    Ok(())
}

// test-category: race
#[test]
fn raced_idle_finish_is_not_rearmed() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    run_race(true);
    Ok(())
}
