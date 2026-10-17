//! A current read mark can prevent restart even after a full backfill.
use super::*;

static FINISHED: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

fn pin_current_snapshot(event: sqlite::CheckpointEvent) {
    if matches!(event, sqlite::CheckpointEvent::WalCommitted(_)) {
        READER.with(|reader| {
            let reader = reader.borrow();
            let reader = reader.as_ref().unwrap();
            if !reader.is_autocommit() {
                reader.execute_batch("ROLLBACK").unwrap();
            }
            reader
                .execute_batch("BEGIN; SELECT * FROM t LIMIT 1")
                .unwrap();
        });
    }
    observe(event);
    if matches!(event, sqlite::CheckpointEvent::Finished { .. })
        && let Some(finished) = FINISHED.lock().unwrap().as_ref()
    {
        let _ = finished.send(());
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
    let (finished, passes) = mpsc::channel();
    *FINISHED.lock().unwrap() = Some(finished);
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pin_current_snapshot))
        .unwrap()
        .unwrap();
    store.insert_many(1100);
    passes.recv_timeout(Duration::from_secs(5)).unwrap();
    // Let the worker finish its completion bookkeeping before the next commit.
    sleep(Duration::from_millis(20));
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
        let _ = passes.recv_timeout(Duration::from_millis(20));
    }
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
    FINISHED.lock().unwrap().take();
    eprintln!(
        "current-reader WAL: commits={COMMITS} new_frames={new_frames} threshold=1000 passes={background}"
    );
    Ok(())
}
