//! A raced threshold snapshot finishes only after an idle report.
use super::*;

// test-category: race
#[test]
fn raced_background_snapshot_waits_for_idle_to_finish() -> Result<(), butler_e2e::e2e::HarnessError>
{
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
    let release = resume;
    owner.lane_busy();
    store.insert_many(2000);
    backfilled.recv_timeout(Duration::from_secs(5)).unwrap();
    let (log, done) = frames(&store.path);
    assert!(log >= 1000);
    assert_eq!(done, log);
    store.insert();
    let (tail, _) = frames(&store.path);
    assert!(tail > log && tail - log < 1000);
    READER.with(|reader| {
        assert!(reader.borrow_mut().take().unwrap().is_autocommit());
    });
    let (finished, completion) = mpsc::sync_channel(1);
    *FINISHED.lock().unwrap() = Some(finished);
    release.send(()).unwrap();
    completion.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(PASSES.load(SeqCst), 1, "background must not chain");
    assert_eq!(FINISHES.load(SeqCst), 0, "busy lane must not finish");
    assert_eq!(frames(&store.path), (tail, log));
    let (finished, completion) = mpsc::sync_channel(1);
    *FINISHED.lock().unwrap() = Some(finished);
    owner.lane_idle();
    completion.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(FINISHES.load(SeqCst), 1);
    assert_eq!(frames(&store.path), (tail, tail));
    owner.lane_busy();
    store.reset_after_quiet();
    owner.lane_idle();
    owner.close().unwrap();
    store.counts(2002);
    Ok(())
}

fn pause_completed_pass(event: sqlite::CheckpointEvent) {
    current_reader::pin_current_snapshot(event);
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
fn pinned_idle_finish_runs_once_and_next_threshold_cycle_retries()
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
    owner.lane_busy();
    store.insert_many(1100);
    first.recv_timeout(Duration::from_secs(5)).unwrap();
    let (initial, done) = frames(&store.path);
    assert_eq!(initial, done);
    store.insert();
    assert_eq!(FINISHES.load(SeqCst), 0);
    let (finish, resume) = pause_next_pass();
    owner.lane_idle();
    release.send(()).unwrap();
    let release = resume;
    finish.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(FINISHES.load(SeqCst), 1);
    let (finished, done) = frames(&store.path);
    assert!(finished > initial);
    assert_eq!(finished, done);
    owner.lane_busy();
    store.insert();
    assert!(
        frames(&store.path).0 > finished,
        "reader mark must prevent reset"
    );
    assert_eq!(FINISHES.load(SeqCst), 1, "finish must not loop");
    let mut count = 1102;
    while frames(&store.path).0 - finished < 1000 {
        store.insert();
        count += 1;
    }
    let (second, resume) = pause_next_pass();
    release.send(()).unwrap();
    let release = resume;
    second.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        PASSES.load(SeqCst),
        3,
        "two threshold passes plus one finish"
    );
    store.insert();
    count += 1;
    READER.with(|reader| reader.borrow_mut().take());
    owner.lane_idle();
    release.send(()).unwrap();
    owner.close().unwrap();
    assert_eq!(FINISHES.load(SeqCst), 2);
    store.reset_after_quiet();
    store.counts(count + 1);
    eprintln!(
        "pinned idle finish: background=2 finish=2 reset_frames={}",
        frames(&store.path).0
    );
    Ok(())
}
