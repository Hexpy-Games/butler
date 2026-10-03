//! Native process composition. Domain policies stay behind their existing APIs.

mod boundary;
mod contracts;
mod defaults;
pub(crate) use defaults::ensure_reply_language;
mod attachments;
pub(super) mod environment;
mod mcp_owner;
mod memory_bootstrap;
pub(super) mod models;
mod monitoring;
mod owners;
pub(super) mod process_probe;
mod skills_owner;
pub(super) mod storage_bootstrap;
pub(super) mod stores;
mod subsession_queue;
mod web_owner;
use super::{AcceptedPlanProducer, ActiveAppEndpoint, CognitionPrompt, ConversationObserver};
use super::{
    GuidedCatalog, GuidedPreparation, GuidedTurnFactoryAdapter, ResolvedInstallation,
    SystemIdentity, SystemPromptClock,
};
use crate::host::memory_jobs::context_maintenance::ContextMaintenance;
use crate::host::memory_jobs::daily::{DailyCognitionJobs, DailyCognitionOwners};
use crate::host::memory_jobs::recall_metrics::RecallMetrics;
use crate::host::runtime::environment::ProcessEnvironment;
use crate::host::runtime::stores::RuntimeStores;
use boundary::{setup, validate_data_installation_boundary};
use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_ledger::project_ledger::{ProjectLedger, ProjectWork};
use butler_memory::cognition::{CognitionPromptReader, ExactMemoryQuery};
use butler_memory::cognition::{MemoryRecall, ProjectCapsuleService};
use butler_memory::profile::ProfileService;
use butler_models::models::ModelConfigurationClock;
use butler_runtime::context::{
    ContextBudgetOwner, ContextConversation, ConversationSessionReference, ConversationTools,
    PromptAssembler, PromptDependencies, ToolOutput,
};
use butler_runtime::operations::MetricFiles;
use butler_turn::btcc;
use butler_turn::btcc::{
    BtccError, BtccRepositories, ContextCompactionRepository, DefaultTurnPreparation,
    DurableWorkService, GuidedContinuationBudgetFactory, HostDependencies, ModelRouteRetryConfig,
    OperationResultRepository, PortFuture, PrincipalAuthority, ProductionAgentLoop,
    SessionWorkRepository, SqliteProjectWorkRuntime, SqliteSubsessionRepository,
    StorageEffectJournal, StorageProgressPublication, ToolJournalRepository,
    TurnFacadeDependencies, TurnModelExecutionFactory,
};
use butler_turn::workspace::{
    Commands, SessionWorkspaceRecovery, SessionWorktrees, WorkspaceFiles, WorkspaceMutations,
};
pub(crate) use contracts::{AgentRuntime, RuntimePaths};
use owners::RuntimeOwners;
use std::path::PathBuf;
use std::sync::Arc;
pub(super) use subsession_queue::SubsessionQueue;
impl AgentRuntime {
    pub(crate) async fn open(
        paths: RuntimePaths,
        app_database_path: PathBuf,
        installation: ResolvedInstallation,
        environment: ProcessEnvironment,
        locale: &str,
        worker_profiles: Arc<dyn butler_turn::btcc::WorkerProfileReader>,
        app: (Arc<ActiveAppEndpoint>, &tokio_util::sync::CancellationToken),
    ) -> Result<Self, BtccError> {
        let (app_endpoint, stop) = app;
        stores::check_startup(stop)?;
        validate_data_installation_boundary(&paths.data_root, &paths.installation_root)?;
        // All fallible in-memory setup precedes the first store owner.
        let collation = Arc::new(LocaleCollation::new(locale).map_err(setup)?);
        let writes = Arc::new(ConfigurationWrites::new());
        let host_environment: Arc<std::collections::HashMap<String, String>> =
            Arc::new(std::env::vars().collect());
        let continuation_limits =
            btcc::select_turn_continuation_budget(|key| host_environment.get(key).cloned())?;
        let mcp_client = mcp_owner::for_runtime(&paths, &host_environment, writes.clone());
        let process_services = web_owner::open(
            &paths,
            environment.model,
            &writes,
            &collation,
            mcp_client.clone(),
        )?;
        let models = self::models::with_moved_credentials(process_services.models).await;
        let web_access = process_services.web_access;
        let (prompt_clock, date_parser) = process_clocks()?;
        let metric_files = Arc::new(MetricFiles::new(paths.data_root.clone()));
        let (coordinator, embedding, vectors, fresh_memory) =
            memory_bootstrap::open(&paths, &environment.cognition_paths).await?;
        let files = WorkspaceFiles::new(4);
        let (image_files, attachment_context) = attachments::owners(&paths.data_root);
        let commands = Commands::new();
        let mutations = WorkspaceMutations::new();
        let (skills, capabilities, catalog) = skills_owner::open(&paths, &files, &mutations)?;
        stores::check_startup(stop)?;
        let stores = RuntimeStores::open(&paths.data_root, collation.clone(), stop).await?;
        let response_language =
            defaults::initialize(&paths, &app_database_path, &installation).await?;
        let (work_streams, observer) = boundary::open_observer(
            &paths.data_root,
            &environment.cognition_paths,
            metric_files.clone(),
            &stores,
        )
        .await?;
        let memory_sync = boundary::MemoryStartup {
            observer: &observer,
            work_streams: &work_streams,
            stores: &stores,
            fresh: fresh_memory,
            stop,
        }
        .open(
            &paths,
            &environment.cognition_paths,
            coordinator.clone(),
            models.provider.clone(),
            embedding.clone(),
            vectors.clone(),
        )
        .await?;
        let capsule_service = Arc::new(ProjectCapsuleService::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            coordinator.clone(),
        ));
        let cognition = Arc::new(CognitionPromptReader::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            2,
        ));
        let profile = defaults::open_profile(
            &paths,
            environment.cognition_paths.cognition_root(&paths.data_root),
            writes,
            coordinator.clone(),
            models.provider.clone(),
            &response_language,
        )
        .await?;
        let project_ledger = ProjectLedger::with_collation(&paths.data_root, 2, collation.clone());
        let plans = AcceptedPlanProducer::from_ledger(project_ledger.clone());
        let project_tools = Arc::new(crate::host::guided::project_tools::GuidedProjectTools::new(
            project_ledger.clone(),
            commands.clone(),
            host_environment.clone(),
            butler_memory::work_records::WorkRecordReader::new(&paths.data_root),
            collation.clone(),
        ));
        let context_budget = Arc::new(ContextBudgetOwner::new(
            models.configuration.clone(),
            models.catalog.clone(),
            environment.context_budget.clone(),
        ));
        let tool_output = super::open_tool_output(
            paths.data_root.clone(),
            context_budget.clone(),
            metric_files.clone(),
        );
        let daily_cognition = Arc::new(DailyCognitionJobs::new(DailyCognitionOwners {
            data_root: paths.data_root.clone(),
            paths: environment.cognition_paths.clone(),
            coordinator: coordinator.clone(),
            metrics: metric_files.clone(),
            consumer: memory_sync.consumer(),
            capsules: capsule_service,
            provider: models.provider.clone(),
            configuration: models.configuration.clone(),
            profile: profile.clone(),
            ledger: project_ledger.clone(),
            date_parser: date_parser.clone(),
            bindings: stores.bindings.clone(),
            embedding: embedding.clone(),
        }));
        let context_maintenance = ContextMaintenance::for_cognition(
            &paths.data_root,
            &tool_output,
            &metric_files,
            &date_parser,
            &daily_cognition,
        );
        let command = Arc::new(crate::host::guided::command::GuidedCommand::new(
            commands.clone(),
            tool_output.clone(),
            host_environment.clone(),
        ));
        let tool_artifacts = Arc::new(super::ToolArtifactReader::new(tool_output.clone()));
        let memory_query = Arc::new(ExactMemoryQuery::new(&paths.data_root, 2));
        let memory_sources = Arc::new(super::MemorySourceReader::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
        ));
        let conversation_reference = Arc::new(ConversationSessionReference::new(
            &paths.data_root,
            2,
            memory_sources,
        ));
        let compare = collation.clone();
        let recall_date_parser = date_parser.clone();
        let memory_recall = MemoryRecall::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            Arc::new(move |value| recall_date_parser.parse(value)),
            Arc::new(move |left, right| compare.compare(left, right)),
            Arc::new(|| SystemIdentity.now_epoch_millis()),
            2,
        )
        .with_metric_sink(Arc::new(RecallMetrics::new(metric_files.clone())));
        let memory_recall = memory_recall.with_vector_port(vectors);
        let memory_recall = Arc::new(memory_recall);
        let conversation_context = ContextConversation::new(
            stores.conversations.clone(),
            models.configuration.clone(),
            models.catalog.clone(),
            environment.context_budget,
        );
        let conversation_tools = Arc::new(ConversationTools::new(
            paths.data_root.clone(),
            Arc::new(conversation_context.clone()),
            2,
        ));
        let prompt = Arc::new(PromptAssembler::new(
            boundary::prompt_paths(&paths, &environment.cognition_paths),
            environment.prompt,
            PromptDependencies {
                profile: profile.clone(),
                cognition: Arc::new(CognitionPrompt::new(cognition.clone())),
                clock: prompt_clock,
            },
            conversation_context,
        ));
        let documents = BtccRepositories::new(stores.btcc.clone(), continuation_limits);
        let context_compactions = documents.context_compactions();
        let repositories = Arc::new(documents.clone());
        let now: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
        let memory_writes =
            memory_bootstrap::rule_owner(&paths, &environment.cognition_paths, &coordinator, stop);
        let preparation = Arc::new(DefaultTurnPreparation::new(
            stores.bindings.clone(),
            stores.conversations.clone(),
            documents.clone(),
            observer.clone(),
            prompt,
            models.configuration.clone(),
        ));
        let authority = Arc::new(PrincipalAuthority::new(
            stores.btcc.clone(),
            collation.clone(),
            now.clone(),
            Arc::new(|| uuid::Uuid::new_v4().to_string()),
        ));
        let session_work = Arc::new(SessionWorkRepository::new(stores.btcc.clone(), now.clone()));
        let project_runtime = Arc::new(SqliteProjectWorkRuntime::new(
            stores.btcc.clone(),
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
                stores.bindings.clone(),
                session_work.clone(),
                Arc::new(
                    crate::host::guided::project_work_provider::ProjectWorkProvider::new(
                        project_ledger.clone(),
                        project_work.clone(),
                    ),
                ),
            ),
        );
        let session_worktrees = SessionWorktrees::new(
            stores.bindings.clone(),
            commands.clone(),
            files.clone(),
            host_environment.clone(),
            paths.data_root.clone(),
            Arc::new(SystemIdentity),
        );
        let workspace_recovery = SessionWorkspaceRecovery::new(
            stores.bindings.clone(),
            commands.clone(),
            files.clone(),
            host_environment.clone(),
        );
        let work_service = Arc::new(DurableWorkService::new(work_repository));
        let inbound_queue = Arc::new(butler_gateway::gateway::InboundQueue::new(&paths.data_root));
        let subsessions = Arc::new(butler_turn::btcc::SubsessionService::new(
            SqliteSubsessionRepository::new(stores.btcc.clone()),
            stores.bindings.clone(),
            Arc::new(SubsessionQueue(inbound_queue.clone())),
            worker_profiles,
            work_service.clone(),
            Arc::new(|| butler_models::models::ModelConfigurationClock::now_iso(&SystemIdentity)),
        ));
        let restart_tool_journal =
            Arc::new(ToolJournalRepository::new(stores.btcc.clone(), now.clone()));
        let restart_effect_journal = Arc::new(StorageEffectJournal::new(stores.btcc.clone(), now));
        let factory = GuidedTurnFactoryAdapter {
            preparation: GuidedPreparation {
                catalog,
                workspace: workspace_recovery.clone(),
                accepted_plans: plans.clone(),
                work: work_service,
                authority: authority.clone(),
                journal: restart_tool_journal.clone(),
                operation_results: Arc::new(
                    OperationResultRepository::with_project_authority_factory(
                        stores.btcc.clone(),
                        Arc::new(
                            crate::host::guided::project_work_provider::ProjectResultAuthority::new(
                                project_ledger.clone(),
                                paths.data_root.clone(),
                            ),
                        ),
                    ),
                ),
                budget: Arc::new(GuidedContinuationBudgetFactory::new(
                    Some(repositories.clone()),
                    Arc::new(|| {
                        u64::try_from(SystemIdentity.now_epoch_millis().max(0)).unwrap_or_default()
                    }),
                )),
                default_workspace: paths.workspace_root.to_string_lossy().into_owned(),
                phase_surface_flag: environment.phase_surface_flag,
                operation_replay_flag: environment.operation_replay_flag,
                subsessions: subsessions.clone(),
            },
            documents,
            effects: restart_effect_journal.clone(),
            capabilities,
            command: command.clone(),
            project_tools: project_tools.clone(),
            tool_artifacts,
            memory_query: memory_query.clone(),
            memory_recall: memory_recall.clone(),
            memory_writes: memory_writes.clone(),
            conversation_reference: conversation_reference.clone(),
            conversation_tools: conversation_tools.clone(),
            compactions: ContextCompactionRepository::new(stores.btcc.clone()),
            attachment_context: attachment_context.clone(),
            verified_image_payload: image_files.clone(),
            protected_ledger_roots: vec![paths.data_root.join("project-ledger")],
            butler_data: paths.data_root.clone(),
            installation_root: paths.installation_root,
            subsessions: subsessions.clone(),
            work_streams: work_streams.clone(),
            mcp_client: mcp_client.clone(),
            profile: profile.clone(),
            monitoring: monitoring::open(
                &paths.data_root,
                &environment.cognition_paths,
                &models,
                coordinator.clone(),
                profile.clone(),
                metric_files.clone(),
            ),
            session_worktrees: session_worktrees.clone(),
            web_access,
            app_endpoint: app_endpoint.clone(),
        };
        let agent = Arc::new(ProductionAgentLoop::native(
            models.provider.clone(),
            Arc::new(TurnModelExecutionFactory::new(
                repositories.clone(),
                ModelRouteRetryConfig::new(environment.model_route_retry_base_ms),
            )),
            Arc::new(factory),
            None,
        ));
        let bindings = stores.bindings.clone();
        let conversations = Arc::new(stores.conversations.clone());
        let progress = StorageProgressPublication::new(stores.btcc.clone());
        let owner = Arc::new(RuntimeOwners {
            stores,
            project_work,
            project_tools,
            session_worktrees: session_worktrees.clone(),
            image_files: image_files.clone(),
            attachment_context,
            memory_sync,
            embedding,
            profile: profile.clone(),
            cognition,
            memory_query,
            memory_recall,
            conversation_reference,
            conversation_tools,
            observer,
            plans,
            command,
            commands,
            tool_output,
            files,
            mutations,
            work_streams: work_streams.clone(),
            skills: skills.clone(),
            context_maintenance: context_maintenance.clone(),
        });
        let assembly = btcc::assemble(&TurnFacadeDependencies {
            preparation,
            store: repositories.clone(),
            agent,
            messages: repositories.clone(),
            progress: repositories.clone(),
            readiness: repositories,
            developer_log_capture: crate::host::service::developer_log::capture(
                paths.data_root.clone(),
                app_database_path,
                installation,
            ),
            host: owner,
        });
        let (memory_management, memory_acquisition) =
            Self::memory_owners(&paths.data_root, &environment.cognition_paths, coordinator);
        Self::finish_startup(Self {
            memory_writes: Arc::new(memory_writes.rules.clone()),
            memory_management,
            memory_acquisition,
            service_shutdown: stop.clone(),
            btcc: assembly.btcc,
            host: assembly.host,
            bindings,
            models,
            context_budget,
            context_compactions,
            collation,
            progress,
            conversations,
            image_files,
            authority,
            project_ledger,
            session_work,
            session_worktrees,
            workspace_recovery,
            inbound_queue,
            restart_tool_journal,
            restart_effect_journal,
            subsessions,
            work_streams,
            skills: skills.clone(),
            mcp_client,
            context_maintenance,
            profile,
        })
    }
}

/// Capture both process time sources before opening any persistent store.
fn process_clocks() -> Result<(Arc<SystemPromptClock>, Arc<super::DateParser>), BtccError> {
    Ok((
        Arc::new(SystemPromptClock::new().map_err(setup)?),
        Arc::new(super::DateParser::from_process().map_err(setup)?),
    ))
}

impl AgentRuntime {
    fn memory_owners(
        data_root: &std::path::Path,
        environment: &butler_memory::cognition::CognitionPathEnvironment,
        coordinator: Arc<butler_memory::coordination::CognitionWriteCoordinator>,
    ) -> (
        Arc<butler_memory::management::MemoryManagement>,
        Arc<crate::host::embedding::worker::assets::Acquisition>,
    ) {
        (
            Arc::new(butler_memory::management::MemoryManagement::new(
                data_root.to_path_buf(),
                environment.clone(),
                coordinator,
            )),
            Arc::new(crate::host::embedding::worker::assets::Acquisition::start(
                data_root.to_path_buf(),
            )),
        )
    }
}

impl AgentRuntime {
    fn finish_startup(runtime: Self) -> Result<Self, BtccError> {
        crate::host::memory_jobs::recover_resets(
            runtime.memory_management.clone(),
            runtime.profile.clone(),
            runtime.memory_writes.clone(),
            runtime.service_shutdown.child_token(),
        );
        Ok(runtime)
    }
}
