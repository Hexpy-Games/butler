//! Work storage adapters and cutover share the process-owned BTCC lane.
use crate::host::app::work_model::AppWorkModel;
use butler_ledger::project_ledger::{ProjectLedger, ProjectWork};
use butler_turn::btcc::{
    BtccError, DurableWorkService, SessionWorkRepository, SqliteProjectWorkRuntime,
};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(super) struct WorkPorts {
    pub project_work: Arc<ProjectWork>,
    pub work_model: Arc<AppWorkModel>,
    pub session_work: Arc<SessionWorkRepository>,
    pub work_service: Arc<DurableWorkService>,
    pub work_cutover: super::work_cutover::CutoverOwner,
}

pub(super) async fn create(
    stores: &super::stores::RuntimeStores,
    ledger: &ProjectLedger,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    data_root: &Path,
    stop: &CancellationToken,
) -> Result<WorkPorts, BtccError> {
    let runtime = Arc::new(SqliteProjectWorkRuntime::new(
        stores.btcc.clone(),
        now.clone(),
        Arc::new(ledger.clone()),
    ));
    let project_work = Arc::new(ProjectWork::new(
        ledger.clone(),
        runtime.clone(),
        runtime.clone(),
        runtime,
    ));
    let session_work = Arc::new(SessionWorkRepository::new(stores.btcc.clone(), now));
    let work_cutover = super::work_cutover::start(
        data_root.to_owned(),
        stores.btcc.clone(),
        project_work.clone(),
        stop,
    )
    .await?;
    let repository = Arc::new(
        crate::host::guided::scope_selected_work::ScopeSelectedWorkRepository::new(
            stores.bindings.clone(),
            session_work.clone(),
            Arc::new(
                crate::host::guided::project_work_provider::ProjectWorkProvider::new(
                    ledger.clone(),
                    project_work.clone(),
                ),
            ),
            stores.btcc.clone(),
        ),
    );
    Ok(WorkPorts {
        work_model: Arc::new(AppWorkModel::new(stores.btcc.clone(), work_cutover.ready())),
        project_work,
        session_work,
        work_service: Arc::new(DurableWorkService::new(repository)),
        work_cutover,
    })
}
