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
    pub subsessions: Arc<butler_turn::btcc::SubsessionService>,
    pub usage_lineage: Arc<butler_runtime::operations::UsageLineage>,
    pub inbound_queue: Arc<butler_gateway::gateway::InboundQueue>,
}

pub(super) async fn create(
    stores: &super::stores::RuntimeStores,
    ledger: &ProjectLedger,
    now: Arc<dyn Fn() -> String + Send + Sync>,
    data_root: &Path,
    stop: &CancellationToken,
    profiles: (
        Arc<dyn butler_turn::btcc::WorkerProfileReader>,
        Arc<crate::host::ActiveAppEndpoint>,
    ),
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
    let work_service = Arc::new(DurableWorkService::new(repository));
    let (subsessions, usage_lineage, inbound_queue) = super::monitoring::session_usage_services(
        stores,
        data_root,
        profiles,
        work_service.clone(),
        &work_cutover,
    )
    .await?;
    Ok(WorkPorts {
        work_model: Arc::new(AppWorkModel::new(
            stores.btcc.clone(),
            work_cutover.ready(),
            subsessions.clone(),
        )),
        project_work,
        session_work,
        work_service,
        subsessions,
        usage_lineage,
        inbound_queue,
        work_cutover,
    })
}
