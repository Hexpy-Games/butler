//! Automatic, resumable conversion. Call blocking operations only on a storage
//! lane or blocking pool. Legacy source rows are retained as rollback evidence.
mod admission;
mod backup;
mod batches;
mod import;
mod shape;
mod source;
mod sql;
mod state;
mod target;
mod version;

pub use admission::{ManagedAdmission, accept};
pub use backup::{
    BackupFile, Manifest, check_epoch as check_epoch_path, prepare, prepare_with_cancel, valid,
};
pub use batches::{batch, begin, needs_source, resume, session_batch};
pub use shape::{Action, Layout, layout};
pub use sql::{ALL, APP_PROJECT_BATCH, APP_SESSIONS, BACKING_UP, CURSOR, EPOCH};
pub use state::{
    CutoverState, CutoverStatus, Reimport, WRITER_EPOCH, check_epoch, reimport, status,
};
