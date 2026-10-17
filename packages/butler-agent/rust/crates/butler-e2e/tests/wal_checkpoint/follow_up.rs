//! A raced due pass drains once; a raced follow-up waits for new frames.
use super::*;

fn pause_backfill(event: sqlite::CheckpointEvent) {
    current_reader::pin_current_snapshot(event);
    if matches!(
        event,
        sqlite::CheckpointEvent::Checkpointed { inline: false, .. }
    ) {
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

fn raced_passes(wait_for_threshold: bool) {
    PASSES.store(0, SeqCst);
    let store = Store::new();
    READER.with(|reader| *reader.borrow_mut() = Some(sqlite::open(&store.path).unwrap()));
    let (due, resume_due) = pause_next_pass();
    let owner = sqlite::CheckpointOwner::start(&store.db, "test", Some(pause_backfill))
        .unwrap()
        .unwrap();
    // Release senders drop before owner on panic, unblocking its join.
    let release_due = resume_due;
    store.insert_many(1100);
    due.recv_timeout(Duration::from_secs(5)).unwrap();
    let (initial, done) = frames(&store.path);
    assert_eq!(initial, done);
    store.insert();
    let (follow_up, resume_follow_up) = pause_next_pass();
    release_due.send(()).unwrap();
    follow_up.recv_timeout(Duration::from_secs(5)).unwrap();
    let release_follow_up = resume_follow_up;
    let (drained, done) = frames(&store.path);
    assert!(drained > initial);
    assert_eq!(drained, done, "due pass did not drain its raced tail");
    store.insert();
    let (tail, done) = frames(&store.path);
    assert!(tail > done && tail - drained < 1000);
    release_follow_up.send(()).unwrap();
    if wait_for_threshold {
        store.insert_many(1000);
    }
    owner.close().unwrap();
    let expected = if wait_for_threshold { 3 } else { 2 };
    assert_eq!(PASSES.load(SeqCst), expected);
    if wait_for_threshold {
        let (log, done) = frames(&store.path);
        assert_eq!(log, done, "new threshold did not backfill the tail");
    } else {
        assert_eq!(frames(&store.path), (tail, done), "follow-up chained again");
    }
    store.counts(if wait_for_threshold { 2102 } else { 1102 });
    READER.with(|reader| reader.borrow_mut().take());
    eprintln!("raced due/follow-up: threshold={wait_for_threshold} passes={expected}");
}

// test-category: race
#[test]
fn raced_due_pass_has_only_one_follow_up_until_new_frame_threshold()
-> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    raced_passes(false);
    raced_passes(true);
    Ok(())
}
