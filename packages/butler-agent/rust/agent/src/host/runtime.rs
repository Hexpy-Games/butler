//! Native process composition. Domain policies stay behind their existing APIs.

mod boundary;
mod contracts;
mod mcp_owner;
mod monitoring;
mod owners;
mod skills_owner;
mod subsession_queue;
mod web_owner;
#[cfg(unix)]
use super::NativeEmbeddingOwner;
use super::context_maintenance::ContextMaintenance;
#[cfg(unix)]
use super::daily_cognition::{DailyCognitionJobs, DailyCognitionOwners};
use super::process_environment::NativeProcessEnvironment;
use super::runtime_stores::RuntimeStores;
use super::{
    NativeAcceptedPlanProducer, NativeActiveAppEndpoint, NativeCognitionPrompt,
    NativeConversationObserver, NativeGuidedCatalog, NativeGuidedPreparation,
    NativeGuidedTurnFactory, NativePromptClock, ProfileConversationSources, ResolvedInstallation,
    SystemIdentity, recall_metrics::RecallMetrics,
};
use crate::btcc::{
    self, BtccError, BtccRepositories, ContextCompactionRepository, DefaultTurnPreparation,
    DurableWorkService, GuidedContinuationBudgetFactory, HostDependencies, ModelRouteRetryConfig,
    NativePrincipalAuthority, OperationResultRepository, PortFuture, ProductionAgentLoop,
    SessionWorkRepository, SqliteProjectWorkRuntime, SqliteSubsessionRepository,
    StorageEffectJournal, StorageProgressPublication, ToolJournalRepository,
    TurnFacadeDependencies, TurnModelExecutionFactory,
};
#[cfg(unix)]
use crate::cognition::NativeGenerationVectorAdapter;
use crate::cognition::{
    CompletionPublisher, NativeCognitionPromptReader, NativeExactMemoryQuery, NativeMemoryRecall,
    ProjectCapsuleService,
};
use crate::configuration::ConfigurationWrites;
use crate::context::{
    ContextBudgetOwner, ContextConversation, NativeConversationSessionReference,
    NativeConversationTools, NativeToolOutput, PromptAssembler, PromptDependencies, PromptPaths,
};
use crate::conversation::conversation_store_path;
use crate::coordination::CognitionWriteCoordinator;
use crate::locale::LocaleCollation;
use crate::models::ModelConfigurationClock;
use crate::operations::MetricFiles;
use crate::profile::{PersonaPresets, ProfileService};
use crate::project_ledger::{NativeProjectLedger, NativeProjectWork};
use crate::workspace::{
    NativeCommands, NativeSessionWorkspaceRecovery, NativeSessionWorktrees, NativeWorkspaceFiles,
    WorkspaceMutations,
};
use boundary::{setup, validate_data_installation_boundary};
pub(crate) use contracts::{NativeAgentRuntime, NativeRuntimePaths};
use owners::RuntimeOwners;
use std::path::PathBuf;
use std::sync::Arc;
pub(super) use subsession_queue::NativeSubsessionQueue;
impl NativeAgentRuntime {
    pub(crate) async fn open(
        paths: NativeRuntimePaths,
        app_database_path: PathBuf,
        installation: ResolvedInstallation,
        environment: NativeProcessEnvironment,
        locale: &str,
        worker_profiles: Arc<dyn crate::btcc::WorkerProfileReader>,
        app_endpoint: Arc<NativeActiveAppEndpoint>,
    ) -> Result<Self, BtccError> {
        validate_data_installation_boundary(&paths.data_root, &paths.installation_root)?;
        // All fallible in-memory setup precedes the first store owner.
        let collation = Arc::new(LocaleCollation::new(locale).map_err(setup)?);
        let writes = Arc::new(ConfigurationWrites::new());
        let host_environment: Arc<std::collections::HashMap<String, String>> =
            Arc::new(std::env::vars().collect());
        let continuation_limits =
            btcc::select_turn_continuation_budget(|key| host_environment.get(key).cloned())?;
        let mcp_client = mcp_owner::for_runtime(&paths, &host_environment.clone(), writes.clone());
        let process_services = web_owner::open(
            &paths,
            environment.model,
            &writes,
            &collation,
            mcp_client.clone(),
        )?;
        let models = process_services.models;
        let web_access = process_services.web_access;
        let prompt_clock = Arc::new(NativePromptClock::new().map_err(setup)?);
        let date_parser = Arc::new(super::NativeDateParser::from_process().map_err(setup)?);
        let metric_files = Arc::new(MetricFiles::new(paths.data_root.clone()));
        let coordinator =
            Arc::new(CognitionWriteCoordinator::new(Arc::new(SystemIdentity)).map_err(setup)?);
        #[cfg(unix)]
        let embedding =
            Arc::new(NativeEmbeddingOwner::new(paths.data_root.clone()).map_err(setup)?);
        #[cfg(unix)]
        let vectors = Arc::new(NativeGenerationVectorAdapter::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            embedding.clone(),
        ));
        let files = NativeWorkspaceFiles::new(4);
        let image_files = Arc::new(crate::gateway::NativeAppImageFiles::new(
            &paths.data_root.clone(),
        ));
        let attachment_context = Arc::new(crate::context::NativeAttachmentContext::new(
            paths.data_root.clone(),
        ));
        let commands = NativeCommands::new();
        let mutations = WorkspaceMutations::new();
        let (skills, capabilities, catalog) = skills_owner::open(&paths, &files, &mutations)?;
        let stores = RuntimeStores::open(&paths.data_root, collation.clone()).await?;
        let work_streams = match super::NativeWorkStreams::open(paths.data_root.clone()) {
            Ok(owner) => Arc::new(owner),
            Err(error) => {
                let _ = stores.close().await;
                return Err(error);
            }
        };
        let observer = match NativeConversationObserver::new(
            &paths.data_root,
            &environment.cognition_paths,
            Arc::new(SystemIdentity),
            metric_files.clone(),
        ) {
            Ok(observer) => Arc::new(observer),
            Err(error) => {
                let _ = work_streams.close().await;
                let _ = stores.close().await;
                return Err(setup(error));
            }
        };
        let memory_sync = match super::memory_sync::NativeMemorySync::open(
            &paths.data_root,
            &environment.cognition_paths,
            coordinator.clone(),
            models.provider.clone(),
            #[cfg(unix)]
            embedding.clone(),
            #[cfg(unix)]
            vectors.clone(),
        ) {
            Ok(owner) => owner,
            Err(error) => {
                let _ = observer.close().await;
                let _ = work_streams.close().await;
                let _ = stores.close().await;
                return Err(error);
            }
        };
        let cognition_root = environment.cognition_paths.cognition_root(&paths.data_root);
        let capsule_service = Arc::new(ProjectCapsuleService::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            coordinator.clone(),
        ));
        let cognition = Arc::new(NativeCognitionPromptReader::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            2,
        ));
        let profile = Arc::new(ProfileService::new(
            paths.data_root.clone(),
            cognition_root.clone(),
            Arc::new(PersonaPresets::new(paths.resource_root.clone())),
            writes,
            coordinator.clone(),
            Arc::new(SystemIdentity),
            Arc::new(ProfileConversationSources::new(conversation_store_path(
                &paths.data_root,
            ))),
            models.provider.clone(),
        ));
        let project_ledger =
            NativeProjectLedger::with_collation(&paths.data_root, 2, collation.clone());
        let plans = NativeAcceptedPlanProducer::from_ledger(project_ledger.clone());
        let project_tools = Arc::new(super::guided_project_tools::NativeGuidedProjectTools::new(
            project_ledger.clone(),
            commands.clone(),
            host_environment.clone(),
            crate::work_records::WorkRecordReader::new(&paths.data_root),
            collation.clone(),
        ));
        let context_budget = Arc::new(ContextBudgetOwner::new(
            models.configuration.clone(),
            models.catalog.clone(),
            environment.context_budget.clone(),
        ));
        let tool_output = super::native_tool_output(
            paths.data_root.clone(),
            context_budget.clone(),
            metric_files.clone(),
        );
        #[cfg(unix)]
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
        let context_maintenance = Arc::new(ContextMaintenance::new(
            paths.data_root.clone(),
            tool_output.clone(),
            metric_files.clone(),
            date_parser.clone(),
            #[cfg(unix)]
            daily_cognition,
        ));
        let command = Arc::new(super::guided_command::NativeGuidedCommand::new(
            commands.clone(),
            tool_output.clone(),
            host_environment.clone(),
        ));
        let tool_artifacts = Arc::new(super::NativeToolArtifactReader::new(tool_output.clone()));
        let memory_query = Arc::new(NativeExactMemoryQuery::new(&paths.data_root.clone(), 2));
        let memory_sources = Arc::new(super::NativeMemorySourceReader::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
        ));
        let conversation_reference = Arc::new(NativeConversationSessionReference::new(
            &paths.data_root.clone(),
            2,
            memory_sources,
        ));
        let compare = collation.clone();
        let recall_date_parser = date_parser.clone();
        let memory_recall = NativeMemoryRecall::new(
            paths.data_root.clone(),
            environment.cognition_paths.clone(),
            Arc::new(move |value| recall_date_parser.parse(value)),
            Arc::new(move |left, right| compare.compare(left, right)),
            Arc::new(|| SystemIdentity.now_epoch_millis()),
            2,
        )
        .with_metric_sink(Arc::new(RecallMetrics::new(metric_files.clone())));
        #[cfg(unix)]
        let memory_recall = memory_recall.with_vector_port(vectors);
        let memory_recall = Arc::new(memory_recall);
        let conversation_context = ContextConversation::new(
            stores.conversations.clone(),
            models.configuration.clone(),
            models.catalog.clone(),
            environment.context_budget,
        );
        let conversation_tools = Arc::new(NativeConversationTools::new(
            paths.data_root.clone(),
            Arc::new(conversation_context.clone()),
            2,
        ));
        let prompt = Arc::new(PromptAssembler::new(
            PromptPaths {
                resource_root: paths.resource_root.clone(),
                data_root: paths.data_root.clone(),
                cognition_root,
            },
            environment.prompt,
            PromptDependencies {
                profile: profile.clone(),
                cognition: Arc::new(NativeCognitionPrompt::new(cognition.clone())),
                clock: prompt_clock,
            },
            conversation_context,
        ));
        let documents = BtccRepositories::new(stores.btcc.clone(), continuation_limits);
        let context_compactions = documents.context_compactions();
        let repositories = Arc::new(documents.clone());
        let now: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
        let memory_publisher = Arc::new(CompletionPublisher::new(
            &paths.data_root.clone(),
            &environment.cognition_paths.clone(),
            now.clone(),
        ));
        let preparation = Arc::new(DefaultTurnPreparation::new(
            stores.bindings.clone(),
            stores.conversations.clone(),
            documents.clone(),
            observer.clone(),
            prompt,
            models.configuration.clone(),
        ));
        let authority = Arc::new(NativePrincipalAuthority::new(
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
        let project_work = Arc::new(NativeProjectWork::new(
            project_ledger.clone(),
            project_runtime.clone(),
            project_runtime.clone(),
            project_runtime,
        ));
        let work_repository = Arc::new(
            super::scope_selected_work::ScopeSelectedWorkRepository::new(
                stores.bindings.clone(),
                session_work.clone(),
                Arc::new(
                    super::project_work_provider::NativeProjectWorkProvider::new(
                        project_ledger.clone(),
                        project_work.clone(),
                    ),
                ),
            ),
        );
        let session_worktrees = NativeSessionWorktrees::new(
            stores.bindings.clone(),
            commands.clone(),
            files.clone(),
            host_environment.clone(),
            paths.data_root.clone(),
            Arc::new(SystemIdentity),
        );
        let workspace_recovery = NativeSessionWorkspaceRecovery::new(
            stores.bindings.clone(),
            commands.clone(),
            files.clone(),
            host_environment.clone(),
        );
        let work_service = Arc::new(DurableWorkService::new(work_repository));
        let inbound_queue = Arc::new(crate::gateway::NativeInboundQueue::new(
            &paths.data_root.clone(),
        ));
        let automations =
            super::open_automation_service(&paths.data_root, date_parser, inbound_queue.clone());
        let subsessions = Arc::new(crate::btcc::NativeSubsessionService::new(
            SqliteSubsessionRepository::new(stores.btcc.clone()),
            stores.bindings.clone(),
            Arc::new(NativeSubsessionQueue(inbound_queue.clone())),
            worker_profiles,
            work_service.clone(),
            Arc::new(|| crate::models::ModelConfigurationClock::now_iso(&SystemIdentity)),
        ));
        let restart_tool_journal =
            Arc::new(ToolJournalRepository::new(stores.btcc.clone(), now.clone()));
        let restart_effect_journal = Arc::new(StorageEffectJournal::new(stores.btcc.clone(), now));
        let factory = NativeGuidedTurnFactory {
            preparation: NativeGuidedPreparation {
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
                            super::project_work_provider::NativeProjectResultAuthority::new(
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
            memory_paths: environment.cognition_paths.clone(),
            memory_publisher,
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
            automations: automations.clone(),
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
            #[cfg(unix)]
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
            automations: automations.clone(),
        });
        let assembly = btcc::assemble(&TurnFacadeDependencies {
            preparation,
            store: repositories.clone(),
            agent,
            messages: repositories.clone(),
            progress: repositories.clone(),
            readiness: repositories,
            developer_log_capture: super::developer_log::capture(
                paths.data_root.clone(),
                app_database_path,
                installation,
            ),
            host: owner,
        });
        Ok(Self {
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
