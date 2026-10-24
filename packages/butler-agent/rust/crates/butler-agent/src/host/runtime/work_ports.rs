//! Work storage adapters share the one process-owned BTCC lane.
use crate::host::app::canon::AppCanon;
use butler_ledger::project_ledger::{ProjectLedger, ProjectWork};
use butler_turn::btcc::{BtccStorage, SqliteProjectWorkRuntime};
use std::sync::Arc;

pub(super) fn create(
    storage: &BtccStorage,
    ledger: &ProjectLedger,
    now: Arc<dyn Fn() -> String + Send + Sync>,
) -> (Arc<ProjectWork>, Arc<AppCanon>) {
    let runtime = Arc::new(SqliteProjectWorkRuntime::new(
        storage.clone(),
        now,
        Arc::new(ledger.clone()),
    ));
    let project = Arc::new(ProjectWork::new(
        ledger.clone(),
        runtime.clone(),
        runtime.clone(),
        runtime,
    ));
    (project, Arc::new(AppCanon::new(storage.clone())))
}
