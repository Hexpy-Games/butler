//! Host composition of native App ports, separate from listener lifecycle.
use super::*;

#[derive(Clone, Copy)]
pub(super) struct Context<'a> {
    pub runtime: &'a AgentRuntime,
    pub data_root: &'a std::path::Path,
    pub installation: &'a ResolvedInstallation,
}

pub(super) async fn dependencies(
    context: Context<'_>,
    owners: &AppServerOwners,
    artifacts: Arc<AppMessageFiles>,
    settings: Arc<AppSettingsFactsAdapter>,
    setup: AppSetup,
    listener_ready: Arc<AtomicBool>,
) -> Result<AppApplicationDependencies, BtccError> {
    let Context {
        runtime,
        data_root,
        installation,
    } = context;
    let identity_clock: Arc<dyn AppIdentityClock> = super::super::schedule_clock::clock();
    let session_workspaces = Arc::new(AppSessionWorkspaces::for_runtime(runtime));
    let readiness = AppReadiness::new(owners.receipt.clone(), listener_ready);
    Ok(AppApplicationDependencies {
        hooks: Some(runtime.hooks.clone()),
        service_shutdown: runtime.service_shutdown.clone(),
        updates: Arc::new(open_updates(data_root, installation)?),
        setup: Arc::new(setup),
        skills: runtime.skills.clone(),
        mcp_client: runtime.mcp_client.clone(),
        native_ingress: Arc::new(AppIngress::new(owners.queue.clone())),
        native_assets: native_assets(runtime, data_root),
        executor_readiness: Arc::new(readiness),
        admission: admission(runtime, artifacts.clone()),
        artifact_materializer: artifacts.clone(),
        message_files: artifacts,
        settings_facts: settings.clone(),
        settings_mutations: Arc::new(AppSettingsMutation::new(
            runtime.models.configuration.clone(),
            runtime.profile.clone(),
            installation.clone(),
            data_root.to_path_buf(),
        )),
        runtime_info: Arc::new(AppRuntimeInfo::open(installation)),
        model_catalog: Arc::new(AppModelCatalog::new(
            runtime.models.configuration.clone(),
            settings.clone(),
            installation.clone(),
            data_root.to_path_buf(),
        )),
        memory_management: Arc::new(AppMemoryManagement::for_runtime(
            runtime,
            identity_clock.clone(),
        )),
        personalization: personalization(&context, identity_clock.clone()),
        monitoring: Arc::new(AppMonitoring::for_runtime(runtime, data_root)),
        context_read: Arc::new(AppContextRead::for_runtime(runtime, data_root).await?),
        identity_clock,
        approval_claims: Arc::new(AppApprovalClaimsAdapter::new(runtime.authority.clone())),
        queue_owner_liveness: Arc::new(AppQueueOwnerLivenessAdapter),
        authority_handoff: Arc::new(AuthorityHandoff::new(
            runtime.authority.clone(),
            owners.queue.clone(),
            Arc::new(|| butler_models::models::ModelConfigurationClock::now_iso(&SystemIdentity)),
        )),
        session_workspaces: session_workspaces.clone(),
        relocation_host: session_workspaces,
        session_work_progress: Arc::new(AppSessionProgress::new(
            runtime.session_work.clone(),
            runtime.project_ledger.clone(),
        )),
        project_dashboard_ledger: Arc::new(AppDashboardLedger::new(runtime.project_ledger.clone())),
        project_dashboard_briefing: Arc::new(AppDashboardBriefing::new(&runtime.models, data_root)),
        plan_decision_ledger: Arc::new(AppPlanDecisionLedger::new(runtime.project_ledger.clone())),
        work_streams: runtime.work_streams.clone(),
        subsessions: Arc::new(AppSubsessions::new(runtime, settings)),
        branch_conversations: Arc::new(AppBranchConversations::new(runtime.conversations.clone())),
        session_title_generator: Arc::new(AppSessionTitleGeneratorAdapter::new(&runtime.models)),
        branch_summarizer: Arc::new(AppBranchSummarizerAdapter::new(&runtime.models)),
    })
}

fn admission(runtime: &AgentRuntime, artifacts: Arc<AppMessageFiles>) -> Arc<AppAdmission> {
    Arc::new(AppAdmission::new(
        runtime.project_ledger.clone(),
        runtime.image_files.clone(),
        runtime.models.configuration.clone(),
        runtime.mcp_client.clone(),
        artifacts,
    ))
}

fn personalization(
    context: &Context<'_>,
    clock: Arc<dyn AppIdentityClock>,
) -> Arc<crate::host::AppPersonalization> {
    Arc::new(crate::host::AppPersonalization::new(
        context.runtime.profile.clone(),
        context.runtime.models.configuration.clone(),
        context.installation.clone(),
        context.data_root.to_path_buf(),
        clock,
    ))
}
