//! Keep queue ownership stable while retiring idle SQLite execution threads.
use super::{
    AppStorageCode, AppStorageError, DatabaseOperation, StorageResult, checkpoint,
    close_connection, event_outbox, lane, metrics, schema, tuning,
};
use butler_platform::sqlite;
use std::{path::Path, sync::Arc};
use tokio::sync::{mpsc, oneshot};

struct Owner<'a> {
    path: &'a Path,
    data: Option<&'a Path>,
    initialized_at: &'a str,
    metrics: &'a Arc<metrics::Metrics>,
}

pub(super) fn run(
    path: &Path,
    data: Option<&std::path::PathBuf>,
    initialized_at: &str,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<()>>,
    metrics: &Arc<metrics::Metrics>,
) -> StorageResult<()> {
    let owner = Owner {
        path,
        data: data.map(std::path::PathBuf::as_path),
        initialized_at,
        metrics,
    };
    let result = owner.serve(&mut receiver, initialized);
    let saved = metrics.save(path);
    result.and(saved)
}

impl Owner<'_> {
    fn serve(
        &self,
        receiver: &mut mpsc::Receiver<DatabaseOperation>,
        initialized: oneshot::Sender<StorageResult<()>>,
    ) -> StorageResult<()> {
        let mut initialized = Some(initialized);
        let mut first = None;
        let mut keeper = None;
        let result = self.sessions(receiver, &mut first, &mut initialized, &mut keeper);
        let closed = keeper.map_or(Ok(()), close_connection);
        result.and(closed)
    }

    fn sessions(
        &self,
        receiver: &mut mpsc::Receiver<DatabaseOperation>,
        first: &mut Option<DatabaseOperation>,
        initialized: &mut Option<oneshot::Sender<StorageResult<()>>>,
        keeper: &mut Option<sqlite::Connection>,
    ) -> StorageResult<()> {
        loop {
            let result = std::thread::scope(|scope| {
                std::thread::Builder::new()
                    .name("butler-app-sqlite".into())
                    .spawn_scoped(scope, || self.session(receiver, first, initialized, keeper))
                    .map_err(|error| {
                        AppStorageError::new(
                            AppStorageCode::AppSqliteThreadSpawnFailed,
                            error.to_string(),
                        )
                    })?
                    .join()
                    .map_err(|_| {
                        AppStorageError::new(
                            AppStorageCode::AppSqliteThreadPanicked,
                            "App SQLite execution thread panicked",
                        )
                    })?
            });
            if let Err(error) = result {
                if let Some(sender) = initialized.take() {
                    let _closed_opener = sender.send(Err(error.clone()));
                    return Err(error);
                }
                if first.is_none() {
                    return Err(error);
                }
                // Fail this admitted batch with its actual error, then park.
                // A later admission gets a fresh attempt instead of a dead lane.
                let queued = receiver.len();
                if let Some(operation) = first.take() {
                    operation.fail(error.clone());
                }
                for _ in 0..queued {
                    if let Ok(operation) = receiver.try_recv() {
                        operation.fail(error.clone());
                    }
                }
            }
            crate::gateway::idle_probe::writer_retired();
            *first = receiver.blocking_recv();
            if first.is_none() {
                return Ok(());
            }
        }
    }

    fn session(
        &self,
        receiver: &mut mpsc::Receiver<DatabaseOperation>,
        first: &mut Option<DatabaseOperation>,
        initialized: &mut Option<oneshot::Sender<StorageResult<()>>>,
        keeper: &mut Option<sqlite::Connection>,
    ) -> StorageResult<()> {
        // The first opener allocates SQLite's initial shared inode/WAL objects. Keep
        // those allocations out of the writer's heavy startup arena as well.
        if keeper.is_none() {
            *keeper = Some(super::wal_index::open(self.path)?);
        }
        let (mut connection, checkpoint) = self.open(initialized.is_some())?;
        let ready = sqlite::sync_wal_index(&connection).map_err(|error| {
            AppStorageError::new(AppStorageCode::AppSqliteWalSyncFailed, error.to_string())
                .with_source(error)
        });
        let result = ready.and_then(|()| {
            let admitted = initialized
                .take()
                .is_none_or(|sender| sender.send(Ok(())).is_ok());
            if admitted {
                lane::run(&mut connection, receiver, first.take())
            } else {
                Ok(())
            }
        });
        #[cfg(feature = "e2e-fixtures")]
        super::retirement_fixture::hold(receiver);
        let drained = checkpoint::close(checkpoint);
        let closed = close_connection(connection);
        self.metrics.retire_writer();
        result.and(drained).and(closed)
    }

    fn open(
        &self,
        initialize: bool,
    ) -> StorageResult<(sqlite::Connection, Option<sqlite::CheckpointOwner>)> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppStorageError::new(
                    AppStorageCode::AppSqliteParentCreateFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?;
        }
        #[cfg(feature = "e2e-fixtures")]
        super::retirement_fixture::opening()?;
        let mut connection = sqlite::open(self.path).map_err(AppStorageError::sqlite)?;
        tuning::configure(&connection)?;
        if initialize {
            schema::migrate(&mut connection, self.data)?;
            schema::seed(&connection, self.initialized_at)?;
            schema::migrate_legacy_schedules(&mut connection, self.data)?;
            tuning::analyze_at_open(&connection)?;
            super::super::monitoring::materialized::refresh(&connection)?;
        }
        connection
            .pragma_update(None, "wal_autocheckpoint", 1000)
            .map_err(AppStorageError::sqlite)?;
        event_outbox::install(&connection, self.metrics.clone());
        metrics::configure(self.metrics, &connection)?;
        let checkpoint = checkpoint::start(&connection)?;
        Ok((connection, checkpoint))
    }
}
