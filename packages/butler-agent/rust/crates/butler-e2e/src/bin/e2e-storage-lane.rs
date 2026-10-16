//! Drives the production App writer and outbox using queued operations on WAL files.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "fixture assertions"
)]
use butler_gateway::gateway::storage_testing::{self, Completion, Events, Operation, Sender};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

type Pending = Arc<Mutex<Completion>>;
type Published = Arc<Mutex<Vec<String>>>;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let path = PathBuf::from(&args[2]);
    match args[1].as_str() {
        "begin" => failed_begin(&path),
        "barrier" => failed_commit(&path, true),
        "commit" => failed_commit(&path, false),
        other => panic!("unknown scenario: {other}"),
    }
}

fn pending(completion: Completion) -> Pending {
    Arc::new(Mutex::new(completion))
}

fn assert_pending(completion: &Pending) {
    assert_eq!(
        completion.lock().unwrap().try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty),
        "operations must share the still-unfinished batch"
    );
}

fn result(completion: Pending) -> Result<(), String> {
    Arc::try_unwrap(completion)
        .ok()
        .unwrap()
        .into_inner()
        .unwrap()
        .wait()
}

fn event_stream() -> (
    Events,
    Published,
    Box<dyn butler_gateway::gateway::EventSubscription>,
) {
    let events = Events::default();
    let published = Arc::new(Mutex::new(Vec::new()));
    let captured = published.clone();
    let subscription = events.subscribe(Arc::new(move |event| {
        captured
            .lock()
            .unwrap()
            .push(event.envelope().event_type.clone());
    }));
    // Subscription immediately emits the existing draft snapshot.
    published.lock().unwrap().clear();
    (events, published, subscription)
}

fn verify_recovery(sender: &Sender, events: &Events, published: &Published, prior: &[&str]) {
    let (inspect, inspected) = Operation::new(true, false, |db| {
        assert!(
            db.is_autocommit(),
            "production recovery left a transaction open"
        );
        let mode: String = db.pragma_query_value(None, "journal_mode", |row| row.get(0))?;
        assert_eq!(mode, "wal");
        Ok(())
    });
    sender.send(inspect).unwrap();
    inspected.wait().unwrap();
    assert_eq!(*published.lock().unwrap(), prior);
    let events = events.clone();
    let (write, written) = Operation::new(false, false, move |db| {
        db.execute_batch("CREATE TABLE recovered(value); INSERT INTO recovered VALUES(7)")?;
        events.append(db, "recovered").unwrap();
        Ok(())
    });
    sender.send(write).unwrap();
    written.wait().unwrap();
    let expected: Vec<_> = prior
        .iter()
        .copied()
        .chain(["recovered"])
        .map(str::to_owned)
        .collect();
    assert_eq!(
        *published.lock().unwrap(),
        expected,
        "committed events must flush before completion"
    );
    let (inspect, inspected) = Operation::new(true, false, move |db| {
        assert!(db.is_autocommit());
        assert_eq!(
            db.query_row("SELECT value FROM recovered", [], |row| row
                .get::<_, i64>(0))?,
            7
        );
        let mut statement = db.prepare("SELECT type FROM events ORDER BY id")?;
        let durable = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            durable, expected,
            "published and durable events must match exactly"
        );
        Ok(())
    });
    sender.send(inspect).unwrap();
    inspected.wait().unwrap();
}

fn failed_begin(path: &Path) {
    let (events, published, _subscription) = event_stream();
    let lock = Arc::new(Mutex::new(Connection::open(path).unwrap()));
    let holder = lock.clone();
    let held = Arc::new(Mutex::new(None));
    let started = held.clone();
    let (read, read_result) = Operation::new(true, false, move |db| {
        assert!(db.is_autocommit());
        let timeout: u64 = db.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
        assert_eq!(timeout, 5_000);
        holder.lock().unwrap().execute_batch("BEGIN IMMEDIATE")?;
        *started.lock().unwrap() = Some(Instant::now());
        Ok(())
    });
    let read_result = pending(read_result);
    let earlier = read_result.clone();
    let (inspect, inspect_result) = Operation::new(true, false, move |_| {
        assert_pending(&earlier);
        Ok(())
    });
    let attempted = events.clone();
    let (write, write_result) = Operation::new(false, false, move |db| {
        attempted.append(db, "rejected").unwrap();
        panic!("failed admission must not execute the write");
    });
    let (sender, thread) =
        storage_testing::start(path.to_owned(), vec![read, inspect, write]).unwrap();
    let error = write_result.wait().unwrap_err();
    assert!(error.contains("database is locked"), "{error}");
    let elapsed = held.lock().unwrap().unwrap().elapsed();
    assert!(
        elapsed >= Duration::from_secs(5),
        "lock did not outlast busy_timeout"
    );
    result(read_result).unwrap();
    inspect_result.wait().unwrap();
    // End only the competing connection's transaction. The writer recovers itself.
    lock.lock().unwrap().execute_batch("COMMIT").unwrap();
    verify_recovery(&sender, &events, &published, &[]);
    drop(sender);
    thread.join().unwrap().unwrap();
    eprintln!("failed BEGIN: lock held {elapsed:?}; all 3 completions and recovery verified");
}

fn prepare(path: &Path) {
    // Seed through the same production owner, then prequeue the failure batch.
    let (schema, result) = Operation::new(true, true, |db| {
        db.execute_batch(
            "CREATE TABLE parent(id PRIMARY KEY);
             CREATE TABLE child(id REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);",
        )
    });
    let (sender, thread) = storage_testing::start(path.to_owned(), vec![schema]).unwrap();
    result.wait().unwrap();
    drop(sender);
    thread.join().unwrap().unwrap();
}

fn queue_barrier(
    initial: &mut Vec<Operation>,
    successes: &mut Vec<Pending>,
    events: &Events,
    published: &Published,
) -> Completion {
    let committed = events.clone();
    let (write, completion) = Operation::new(false, false, move |db| {
        db.execute_batch("INSERT INTO parent VALUES(1)")?;
        committed.append(db, "committed").unwrap();
        Ok(())
    });
    let completion = pending(completion);
    let earlier = completion.clone();
    let (inspect, inspected) = Operation::new(true, false, move |_| {
        assert_pending(&earlier);
        Ok(())
    });
    let barrier_events = published.clone();
    let barrier_outbox = events.clone();
    // Even a caller requesting inspect=false must get an exclusive operation.
    let (barrier, barrier_result) = Operation::new(false, true, move |db| {
        assert!(db.is_autocommit());
        assert_eq!(*barrier_events.lock().unwrap(), ["committed"]);
        let tx = db.transaction()?;
        tx.execute_batch("INSERT INTO parent VALUES(3)")?;
        barrier_outbox.append(&tx, "barrier").unwrap();
        tx.commit()?;
        eprintln!("writing barrier transaction committed");
        Ok(())
    });
    initial.extend([write, inspect, barrier]);
    successes.extend([completion, pending(inspected)]);
    barrier_result
}

fn verify_barrier(mut completion: Completion, published: &Published, path: &Path) {
    assert_eq!(
        completion.try_recv(),
        Ok(Ok(())),
        "barrier must complete before the next group runs"
    );
    eprintln!("writing barrier completion observed");
    assert_eq!(*published.lock().unwrap(), ["committed", "barrier"]);
    let reader = butler_platform::sqlite::open(path).unwrap();
    let parents: Vec<i64> = reader
        .prepare("SELECT id FROM parent ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        parents,
        [1, 3],
        "fresh reader must see the barrier's writes"
    );
    let events: Vec<String> = reader
        .prepare("SELECT type FROM events ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(events, ["committed", "barrier"]);
}

fn failed_commit(path: &Path, with_barrier: bool) {
    prepare(path);
    let (events, published, _subscription) = event_stream();
    let mut initial = Vec::new();
    let mut successes = Vec::new();
    let barrier_completion =
        with_barrier.then(|| queue_barrier(&mut initial, &mut successes, &events, &published));
    let uncommitted = events.clone();
    let flushed = published.clone();
    let read_path = path.to_owned();
    let (write, completion) = Operation::new(false, false, move |db| {
        if let Some(barrier) = barrier_completion {
            verify_barrier(barrier, &flushed, &read_path);
        }
        db.execute_batch("INSERT INTO parent VALUES(2)")?;
        uncommitted.append(db, "rolled-back").unwrap();
        Ok(())
    });
    let completion = pending(completion);
    let earlier = completion.clone();
    let (invalid, invalid_result) = Operation::new(false, false, move |db| {
        assert_pending(&earlier);
        db.execute_batch("INSERT INTO child VALUES(99)")
    });
    initial.extend([write, invalid]);
    let (sender, thread) = storage_testing::start(path.to_owned(), initial).unwrap();
    let invalid_error = invalid_result.wait().unwrap_err();
    for success in successes {
        result(success).unwrap();
    }
    for error in [result(completion).unwrap_err(), invalid_error] {
        assert!(error.contains("FOREIGN KEY constraint failed"), "{error}");
    }
    let expected = if with_barrier {
        vec!["committed", "barrier"]
    } else {
        vec![]
    };
    verify_recovery(&sender, &events, &published, &expected);
    let (inspect, inspected) = Operation::new(true, false, move |db| {
        let parents: Vec<i64> = db
            .prepare("SELECT id FROM parent ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        assert_eq!(parents, if with_barrier { vec![1, 3] } else { vec![] });
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM child", [], |row| row.get::<_, i64>(0))?,
            0
        );
        Ok(())
    });
    sender.send(inspect).unwrap();
    inspected.wait().unwrap();
    drop(sender);
    thread.join().unwrap().unwrap();
    eprintln!(
        "failed COMMIT (barrier={with_barrier}): all completions, rollback, events and next batch verified"
    );
}
