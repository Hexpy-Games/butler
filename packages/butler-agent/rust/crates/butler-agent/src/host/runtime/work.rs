//! Composition of the selected Work writer and immutable Spec publication port.
use super::*;

pub(super) struct WorkServices {
    pub(super) session_work: Arc<SessionWorkRepository>,
    pub(super) project_work: Arc<ProjectWork>,
    pub(super) work_service: Arc<DurableWorkService>,
    pub(super) work_model: Option<Arc<butler_turn::btcc::work_model::WorkModelService>>,
}

pub(super) async fn work_services(
    btcc: butler_turn::btcc::BtccStorage,
    bindings: butler_turn::workspace::SessionBindingStore,
    project_ledger: ProjectLedger,
    now: Arc<dyn Fn() -> String + Send + Sync>,
) -> Result<WorkServices, BtccError> {
    let session_work = Arc::new(SessionWorkRepository::new(btcc.clone(), now.clone()));
    let project_runtime = Arc::new(SqliteProjectWorkRuntime::new(
        btcc.clone(),
        now.clone(),
        Arc::new(project_ledger.clone()),
    ));
    let project_work = Arc::new(ProjectWork::new(
        project_ledger.clone(),
        project_runtime.clone(),
        project_runtime.clone(),
        project_runtime,
    ));
    let work_repository = Arc::new(
        crate::host::guided::scope_selected_work::ScopeSelectedWorkRepository::new(
            bindings.clone(),
            session_work.clone(),
            Arc::new(
                crate::host::guided::project_work_provider::ProjectWorkProvider::new(
                    project_ledger.clone(),
                    project_work.clone(),
                ),
            ),
        ),
    );
    let work_model = butler_turn::btcc::work_model::WorkModelService::open(
        btcc.clone(),
        Arc::new(project_ledger.clone()),
        std::env::var("BUTLER_WORK_MODEL").as_deref() == Ok("core"),
    )
    .await?;
    let work_service =
        Arc::new(DurableWorkService::new(work_repository).with_work_model(work_model.clone()));
    Ok(WorkServices {
        session_work,
        project_work,
        work_service,
        work_model,
    })
}
