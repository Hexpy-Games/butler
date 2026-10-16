//! App checkpoint lifetime and content-free maintenance diagnostics.
use super::{AppStorageCode, AppStorageError, StorageResult};
use butler_platform::sqlite;

pub(super) fn start(db: &rusqlite::Connection) -> StorageResult<Option<sqlite::CheckpointOwner>> {
    let observer = (command_timings() || super::metrics::enabled())
        .then_some(observe as sqlite::CheckpointObserver);
    sqlite::CheckpointOwner::start(db, observer).map_err(error)
}

fn command_timings() -> bool {
    std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref() == Some(std::ffi::OsStr::new("1"))
}

pub(super) fn close(owner: Option<sqlite::CheckpointOwner>) -> StorageResult<()> {
    if let Some(owner) = owner {
        owner.close().map_err(error)?;
    }
    Ok(())
}

fn observe(event: sqlite::CheckpointEvent) {
    if let sqlite::CheckpointEvent::WalCommitted(frames) = event {
        super::metrics::wal_committed(frames);
    }
    if let sqlite::CheckpointEvent::Finished { elapsed, succeeded } = event
        && command_timings()
    {
        crate::gateway::command_timing::CommandTiming::report_duration(
            "app_sqlite_checkpoint",
            if succeeded {
                "background_passive_finished"
            } else {
                "background_passive_failed"
            },
            elapsed,
        );
    }
}

fn error(error: sqlite::CheckpointError) -> AppStorageError {
    AppStorageError::new(AppStorageCode::AppSqliteWalSyncFailed, error.to_string())
        .with_source(error)
}
