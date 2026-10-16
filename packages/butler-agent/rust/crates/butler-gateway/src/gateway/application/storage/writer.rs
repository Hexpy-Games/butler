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
    runtime: &'a tokio::runtime::Handle,
}

pub(super) fn run(
    path: &Path,
    data: Option<&std::path::PathBuf>,
    initialized_at: &str,
    mut receiver: mpsc::Receiver<DatabaseOperation>,
    initialized: oneshot::Sender<StorageResult<()>>,
    metrics: &Arc<metrics::Metrics>,
    runtime: &tokio::runtime::Handle,
) -> StorageResult<()> {
    let owner = Owner {
        path,
        data: data.map(std::path::PathBuf::as_path),
        initialized_at,
        metrics,
        runtime,
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
        loop {
            std::thread::scope(|scope| {
                std::thread::Builder::new()
                    .name("butler-app-sqlite".into())
                    .spawn_scoped(scope, || {
                        self.session(receiver, first.take(), initialized.take())
                    })
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
            })?;
            // The coordinator owns the receiver throughout retirement. A
            // request arriving during close remains queued for the next owner.
            first = receiver.blocking_recv();
            if first.is_none() {
                return Ok(());
            }
        }
    }

    fn session(
        &self,
        receiver: &mut mpsc::Receiver<DatabaseOperation>,
        first: Option<DatabaseOperation>,
        initialized: Option<oneshot::Sender<StorageResult<()>>>,
    ) -> StorageResult<()> {
        let (mut connection, checkpoint) = match self.open(initialized.is_some()) {
            Ok(opened) => opened,
            Err(error) => {
                if let Some(initialized) = initialized {
                    let _closed_opener = initialized.send(Err(error.clone()));
                }
                return Err(error);
            }
        };
        let ready = sqlite::sync_wal_index(&connection).map_err(|error| {
            AppStorageError::new(AppStorageCode::AppSqliteWalSyncFailed, error.to_string())
                .with_source(error)
        });
        let admitted = initialized.is_none_or(|sender| sender.send(ready.clone()).is_ok());
        let result = ready.and_then(|()| {
            if admitted {
                lane::run(&mut connection, receiver, self.runtime, first)
            } else {
                Ok(())
            }
        });
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
