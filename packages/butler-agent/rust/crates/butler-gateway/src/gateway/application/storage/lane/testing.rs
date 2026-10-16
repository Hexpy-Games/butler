//! Dev-only access to deterministic admission/commit ordering for E2E companions.
use super::*;
use std::sync::mpsc::{Receiver, channel};

type ResultReceiver = Receiver<Result<(), String>>;

pub struct LaneFixture {
    db: Connection,
    opened: Option<Instant>,
    synced_changes: u64,
    completions: Vec<Completion>,
    result: StorageResult<()>,
}

impl LaneFixture {
    pub fn new() -> rusqlite::Result<Self> {
        Ok(Self {
            db: Connection::open_in_memory()?,
            opened: None,
            synced_changes: 0,
            completions: Vec::new(),
            result: Ok(()),
        })
    }

    pub fn sql(&self, sql: &str) -> rusqlite::Result<()> {
        self.db.execute_batch(sql)
    }

    pub fn begin(&mut self) -> rusqlite::Result<()> {
        self.sql("BEGIN IMMEDIATE")?;
        self.opened = Some(Instant::now());
        Ok(())
    }

    /// Stage an already admitted operation before the next drain.
    pub fn stage(&mut self, sql: &str) -> ResultReceiver {
        let (operation, result) = operation(true, false, sql);
        perform(&mut self.db, operation, Ok(()), &mut self.completions);
        result
    }

    pub fn admit(&mut self, inspect: bool, barrier: bool, sql: &str) -> ResultReceiver {
        let (operation, result) = operation(inspect, barrier, sql);
        let (_sender, mut receiver) = mpsc::channel(1);
        self.result = drain(
            &mut self.db,
            operation,
            &mut receiver,
            &mut self.opened,
            &mut self.synced_changes,
            &mut self.completions,
        );
        result
    }

    pub fn finish(&mut self) {
        let result = self
            .result
            .clone()
            .and_then(|()| commit(&self.db, &mut self.opened))
            .and_then(|()| sync(&self.db, &mut self.synced_changes));
        complete(&mut self.completions, &result);
    }

    pub fn is_autocommit(&self) -> bool {
        self.db.is_autocommit()
    }

    pub fn is_synced(&self) -> bool {
        self.synced_changes == self.db.total_changes()
    }

    pub fn query_count(&self, sql: &str) -> rusqlite::Result<u64> {
        self.db.query_row(sql, [], |row| row.get(0))
    }
}

fn operation(inspect: bool, barrier: bool, sql: &str) -> (Operation, ResultReceiver) {
    let (sender, receiver) = channel();
    let sql = sql.to_owned();
    (
        Operation {
            inspect,
            barrier,
            run: Box::new(move |db, admission| {
                let result = admission
                    .and_then(|()| db.execute_batch(&sql).map_err(AppStorageError::sqlite));
                Box::new(move |commit| {
                    let _closed = sender.send(result.and(commit).map_err(|error| error.message()));
                })
            }),
        },
        receiver,
    )
}
