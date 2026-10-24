//! Dev-only adapters into the production connection owner, jobs and event stream.
use super::{AppStorageError, StorageResult, lane, metrics, operation, run_connection_lane};
use crate::gateway::{EventSubscription, PublishedEvent};
use rusqlite::Connection;
use std::{path::PathBuf, sync::Arc, thread::JoinHandle};
use tokio::sync::{mpsc, oneshot};

/// Opaque production job; the companion controls only the operation and ordering.
pub struct Operation(lane::Operation);
pub struct Completion(oneshot::Receiver<StorageResult<()>>);

impl Operation {
    pub fn new(
        inspect: bool,
        barrier: bool,
        action: impl FnOnce(&mut Connection) -> rusqlite::Result<()> + Send + 'static,
    ) -> (Self, Completion) {
        let (tx, rx) = oneshot::channel();
        let job = operation::job(
            move |db| action(db).map_err(AppStorageError::sqlite),
            tx,
            Arc::new(metrics::Metrics::default()),
            inspect,
            barrier,
        );
        (Self(job), Completion(rx))
    }
}

impl Completion {
    pub fn wait(self) -> Result<(), String> {
        self.0
            .blocking_recv()
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())
    }

    pub fn try_recv(&mut self) -> Result<Result<(), String>, oneshot::error::TryRecvError> {
        self.0
            .try_recv()
            .map(|result| result.map_err(|error| error.to_string()))
    }
}

pub struct Sender(mpsc::Sender<lane::Operation>);
impl Sender {
    pub fn send(&self, operation: Operation) -> Result<(), String> {
        self.0
            .blocking_send(operation.0)
            .map_err(|error| error.to_string())
    }
}

pub type WriterThread = JoinHandle<Result<(), String>>;

/// Queue the initial operations before the real writer can drain them.
/// Initialization, WAL tuning, hooks, recovery and close all use production code.
pub fn start(path: PathBuf, initial: Vec<Operation>) -> std::io::Result<(Sender, WriterThread)> {
    let (tx, rx) = mpsc::channel(super::OPERATION_QUEUE_CAPACITY);
    for operation in initial {
        tx.try_send(operation.0)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
    }
    let (initialized_tx, initialized_rx) = oneshot::channel();
    let thread = std::thread::Builder::new()
        .name("butler-app-sqlite".to_owned())
        .spawn(move || {
            run_connection_lane(
                &path,
                None,
                "2026-01-01T00:00:00Z",
                rx,
                initialized_tx,
                &Arc::new(metrics::Metrics::default()),
            )
            .map_err(|error| error.to_string())
        })?;
    // Keep the opener alive until initialization has acknowledged it.
    let _initialized = initialized_rx.blocking_recv();
    Ok((Sender(tx), thread))
}

#[derive(Clone, Default)]
pub struct Events(super::super::events::EventSubscribers);
impl Events {
    pub fn subscribe(
        &self,
        listener: Arc<dyn Fn(Arc<PublishedEvent>) + Send + Sync>,
    ) -> Box<dyn EventSubscription> {
        self.0.subscribe(listener)
    }

    pub fn append(&self, db: &Connection, event_type: &str) -> Result<(), String> {
        super::super::events::append(
            db,
            &self.0,
            event_type,
            None,
            Default::default(),
            "2026-01-01T00:00:00Z",
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    }
}

/// Production statements exposed for the stub E2E query-plan pins.
pub fn pending_ask_plan_statements() -> Vec<(String, &'static str)> {
    use super::super::pending_asks::{self, events, metadata, plans};
    let mut statements = Vec::new();
    for sql in [plans::SESSION, plans::FIND, plans::DELETE, plans::COUNT] {
        statements.push((sql.into(), "sqlite_autoindex_app_open_plan_decisions_1"));
    }
    for sql in [plans::GLOBAL, plans::BEFORE] {
        statements.push((sql.into(), "app_open_plan_decisions_created"));
    }
    for sql in [
        events::QUEUED,
        events::CURSOR,
        events::ADVANCE,
        events::PRUNE,
    ] {
        statements.push((sql.into(), "INTEGER PRIMARY KEY"));
    }
    statements.push(("SELECT chat_id FROM app_open_plan_decisions INDEXED BY app_open_plan_decisions_message WHERE message_id=?1".into(), "app_open_plan_decisions_message"));
    statements.push((pending_asks::CHAT.into(), "sqlite_autoindex_chats_1"));
    for sql in [plans::INSERT, events::ENQUEUE] {
        statements.push((sql.into(), ""));
    }
    statements.push((metadata::CHAT_MESSAGE.into(), "messages_assistant_turn_idx"));
    statements.push((
        super::schema::pending_asks::LATEST_ASSISTANT.into(),
        "messages_chat_assistant_rowid",
    ));
    statements
}
