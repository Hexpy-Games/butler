//! A current read mark can prevent restart even after a full backfill.
use super::*;

pub(super) fn pin_current_snapshot(event: sqlite::CheckpointEvent) {
    if matches!(event, sqlite::CheckpointEvent::WalCommitted(_)) {
        READER.with(|reader| {
            let reader = reader.borrow();
            let Some(reader) = reader.as_ref() else {
                return;
            };
            if !reader.is_autocommit() {
                reader.execute_batch("ROLLBACK").unwrap();
            }
            reader
                .execute_batch("BEGIN; SELECT * FROM t LIMIT 1")
                .unwrap();
        });
    }
    observe(event);
}

fn pause_current_pass(event: sqlite::CheckpointEvent) {
    pin_current_snapshot(event);
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
fn current_reader_after_full_pass_waits_for_new_frame_threshold()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    PASSES.store(0, SeqCst);
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (finished, passes) = mpsc::sync_channel(1);
    let (resume, paused) = mpsc::sync_channel(1);
    *PAUSE.lock().unwrap() = Some((finished, paused));
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_current_pass))
        .unwrap()
        .unwrap();
    let release = resume;
    store.insert_many(1100);
    passes.recv_timeout(Duration::from_secs(5)).unwrap();
    let (initial, done) = frames(&store.path);
    assert_eq!(
        initial, done,
        "reader must hold the fully backfilled snapshot"
    );
    const COMMITS: usize = 100;
    for _ in 0..COMMITS {
        // Each commit starts with the previous current snapshot pinned. The
        // hook advances that read mark before waking maintenance, permitting
        // another full pass while preventing the writer from resetting WAL.
        store.insert();
    }
    release.send(()).unwrap();
    owner.close().unwrap();
    let (tail, _) = frames(&store.path);
    let new_frames = usize::try_from(tail - initial).unwrap();
    assert!(tail > initial && new_frames < 1000);
    let background = PASSES.load(SeqCst);
    assert!(
        background <= 1 + new_frames / 1000,
        "passes={background} new_frames={new_frames}"
    );
    store.counts(1200);
    READER.with(|reader| reader.borrow_mut().take());
    eprintln!(
        "current-reader WAL: commits={COMMITS} new_frames={new_frames} threshold=1000 passes={background}"
    );
    Ok(())
}
