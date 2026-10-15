//! BTCC checkpoint ownership and content-free diagnostics.
use super::{StorageCode, StorageError, StorageResult, timing};
use crate::btcc::agent_loop::command_timing::CommandTiming;
use butler_platform::sqlite;

pub(super) struct CheckpointOwner(pub(super) sqlite::CheckpointOwner);
impl CheckpointOwner {
    pub(super) fn start(db: &rusqlite::Connection) -> StorageResult<Option<Self>> {
        let observer = (std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
            == Some(std::ffi::OsStr::new("1")))
        .then_some(observe as sqlite::CheckpointObserver);
        sqlite::CheckpointOwner::start(db, observer)
            .map(|owner| owner.map(Self))
            .map_err(error)
    }
    pub(super) fn close(self) -> StorageResult<()> {
        self.0.close().map_err(error)
    }
}
fn observe(event: sqlite::CheckpointEvent) {
    match event {
        sqlite::CheckpointEvent::WalCommitted(pages) => timing::wal_committed(pages),
        sqlite::CheckpointEvent::Finished { elapsed, succeeded } => CommandTiming::report_duration(
            "sqlite_checkpoint",
            if succeeded {
                "background_passive_finished"
            } else {
                "background_passive_failed"
            },
            elapsed,
        ),
    }
}
fn error(error: sqlite::CheckpointError) -> StorageError {
    StorageError::new(StorageCode::SqliteWalSyncFailed, error.to_string()).with_source(error)
}
