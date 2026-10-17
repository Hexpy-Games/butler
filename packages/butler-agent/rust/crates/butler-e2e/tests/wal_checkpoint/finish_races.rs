//! Deterministic writer/maintenance interleavings at pass start and backfill.
use super::*;
use std::sync::atomic::AtomicBool;

static PAUSE_START: AtomicBool = AtomicBool::new(false);

fn pause_pass(event: sqlite::CheckpointEvent) {
    current_reader::pin_current_snapshot(event);
    let should_pause = if PAUSE_START.load(SeqCst) {
        matches!(event, sqlite::CheckpointEvent::Started)
    } else {
        matches!(
            event,
            sqlite::CheckpointEvent::Checkpointed { inline: false, .. }
        )
    };
    if should_pause {
        let pause = PAUSE.lock().unwrap().take();
        if let Some((arrived, resume)) = pause {
            arrived.send(()).unwrap();
            let _ = resume.recv();
        }
    }
}

fn pause_next(start: bool) -> (mpsc::Receiver<()>, mpsc::SyncSender<()>) {
    PAUSE_START.store(start, SeqCst);
    let (arrived, paused) = mpsc::sync_channel(1);
    let (resume, release) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((arrived, release));
    (paused, resume)
}

fn run_race(pause_at_start: bool) {
    let _serial = SERIAL.lock().unwrap();
    FINISHES.store(0, SeqCst);
    PASSES.store(0, SeqCst);
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (first, resume) = pause_next(false);
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_pass))
        .unwrap()
        .unwrap();
    let release = resume;
    store.insert_many(1100);
    first.recv_timeout(Duration::from_secs(5)).unwrap();
    // Queue another threshold before the first pass publishes finish_pending.
    store.insert_many(1100);
    let (second, resume) = pause_next(pause_at_start);
    release.send(()).unwrap();
    let release = resume;
    second.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(FINISHES.load(SeqCst), 0);
    let (committed, returned) = mpsc::sync_channel(1);
    // Always release the paused worker, including on regression or panic.
    let watchdog = std::thread::spawn(move || {
        let returned = returned.recv_timeout(Duration::from_secs(2)).is_ok();
        let _ = release.send(());
        returned
    });
    store.insert();
    let expected = usize::from(pause_at_start);
    let finishes = FINISHES.load(SeqCst);
    let (finished, completion) = mpsc::sync_channel(1);
    *FINISHED.lock().unwrap() = Some(finished);
    let _ = committed.send(());
    assert!(
        watchdog.join().unwrap(),
        "commit waited for paused maintenance"
    );
    assert_eq!(finishes, expected);
    completion.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(PASSES.load(SeqCst), 2);
    // Mid-pass skip must re-arm once; a finish after the start snapshot must not.
    store.insert();
    assert_eq!(FINISHES.load(SeqCst), 1);
    store.insert();
    assert_eq!(FINISHES.load(SeqCst), 1, "second finish for the same pass");
    owner.close().unwrap();
    store.counts(2203);
    READER.with(|reader| reader.borrow_mut().take());
}

// test-category: race
#[test]
fn finish_skips_busy_worker_without_waiting_for_commit() -> Result<(), butler_e2e::e2e::HarnessError>
{
    butler_e2e::gate!();
    run_race(false);
    Ok(())
}

// test-category: race
#[test]
fn pass_completed_after_writer_finish_does_not_rearm() -> Result<(), butler_e2e::e2e::HarnessError>
{
    butler_e2e::gate!();
    run_race(true);
    Ok(())
}
