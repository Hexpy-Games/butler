//! Fully backfilled passes chain only while commits race them.
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

fn raced_passes(race_follow_up: bool) {
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
    if race_follow_up {
        store.insert();
        let (tail, done) = frames(&store.path);
        assert!(tail > done && tail - drained < 1000);
        // This tail does not halve: any raced full pass must chain again.
        assert!(2 * (tail - drained) > drained - initial);
    }
    let (tail, _) = frames(&store.path);
    release_follow_up.send(()).unwrap();
    owner.close().unwrap();
    let expected = if race_follow_up { 3 } else { 2 };
    assert_eq!(PASSES.load(SeqCst), expected);
    assert_eq!(frames(&store.path), (tail, tail));
    store.counts(if race_follow_up { 1102 } else { 1101 });
    READER.with(|reader| reader.borrow_mut().take());
    eprintln!("raced due/follow-up: raced_follow_up={race_follow_up} passes={expected}");
}

// test-category: race
#[test]
fn raced_follow_up_chains_again() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    raced_passes(true);
    Ok(())
}

// test-category: race
#[test]
fn follow_up_without_raced_commit_ends_chain() -> Result<(), butler_e2e::e2e::HarnessError> {
    butler_e2e::gate!();
    let _serial = SERIAL.lock().unwrap();
    raced_passes(false);
    Ok(())
}
