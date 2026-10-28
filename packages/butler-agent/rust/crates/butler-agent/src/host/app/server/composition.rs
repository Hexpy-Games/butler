//! Host composition of native App ports, separate from listener lifecycle.
use super::super::runtime_ports::AppDataReset;
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
    let (monitoring, context_read) = usage_ports(runtime, data_root).await?;
    let readiness = AppReadiness::new(owners.receipt.clone(), listener_ready);
    Ok(AppApplicationDependencies {
        plugins: Some(Arc::new(crate::host::plugins::Admin(
            runtime.plugins.clone(),
        ))),
        hooks: Some(runtime.hooks.clone()),
        data_reset: Some(Arc::new(AppDataReset(runtime.data_reset.clone()))),
        service_shutdown: runtime.service_shutdown.clone(),
        updates: Arc::new(open_updates(data_root, installation)?),
        setup: Arc::new(setup),
        skills: runtime.skills.clone(),
        mcp_client: runtime.mcp_client.clone(),
        native_ingress: Arc::new(AppIngress::new(
            owners.queue.clone(),
            runtime.authority.clone(),
            runtime.data_reset.clone(),
        )),
        native_assets: native_assets(runtime, data_root),
        executor_readiness: Arc::new(readiness),
        admission: admission(runtime, artifacts.clone()),
        artifact_materializer: artifacts.clone(),
        message_files: artifacts,
        settings_facts: settings.clone(),
        settings_mutations: settings_mutations(&context),
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
        monitoring,
        context_read,
        identity_clock,
        approval_claims: Arc::new(AppApprovalClaimsAdapter::new(runtime.authority.clone())),
        queue_owner_liveness: Arc::new(AppQueueOwnerLivenessAdapter),
        authority_handoff: authority_handoff(context, owners),
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
        canon: runtime.canon.clone(),
        branch_conversations: Arc::new(AppBranchConversations::new(runtime.conversations.clone())),
        session_title_generator: Arc::new(AppSessionTitleGeneratorAdapter::new(&runtime.models)),
        session_topic_classifier: Arc::new(AppSessionTopicClassifierAdapter::new(&runtime.models)),
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

async fn usage_ports(
    runtime: &AgentRuntime,
    data_root: &std::path::Path,
) -> Result<(Arc<AppMonitoring>, Arc<AppContextRead>), BtccError> {
    let lineage = runtime.usage_lineage.clone();
    Ok((
        Arc::new(AppMonitoring::for_runtime(
            runtime,
            data_root,
            lineage.clone(),
        )),
        Arc::new(AppContextRead::for_runtime(runtime, data_root, lineage).await?),
    ))
}

fn settings_mutations(context: &Context<'_>) -> Arc<AppSettingsMutation> {
    Arc::new(AppSettingsMutation::new(
        context.runtime.models.configuration.clone(),
        context.runtime.profile.clone(),
        context.installation.clone(),
        context.data_root.to_path_buf(),
        context.runtime.daily_cognition.gate.clone(),
    ))
}

fn authority_handoff(context: Context<'_>, owners: &AppServerOwners) -> Arc<AuthorityHandoff> {
    Arc::new(AuthorityHandoff::new(
        context.runtime.authority.clone(),
        context.runtime.continuity.clone(),
        owners.queue.clone(),
        Arc::new(|| butler_models::models::ModelConfigurationClock::now_iso(&SystemIdentity)),
    ))
}
