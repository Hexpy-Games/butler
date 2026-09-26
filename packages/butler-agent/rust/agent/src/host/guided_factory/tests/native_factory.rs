use super::*;

#[tokio::test]
async fn native_factory_reads_physical_file_journals_result_and_continues_provider() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("native-factory-read"))
        .await
        .unwrap();
    let documents = BtccRepositories::new(storage.clone(), None);
    let marker = "NATIVE_PROFILE_MARKER";
    let profile_ref = documents
        .persist_context_document(ContextDocumentInput {
            scope_kind: "user".into(),
            scope_id: "user".into(),
            projection_class: "profile".into(),
            source_id: "eol".into(),
            source_revision: "1".into(),
            content: format!("Assistant Response Language: English\n{marker}"),
        })
        .await
        .unwrap();
    let scratch =
        Scratch(std::env::temp_dir().join(format!("butler-b3b-{}", uuid::Uuid::new_v4())));
    let (web_endpoint, web_page_url, web_server) = web_search_loopback().await;
    let workspace = scratch.0.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(workspace.join("proof.txt"), "native-file-proof\n").unwrap();
    let mut prepared = test_prepared_turn();
    prepared.request.route.workspace_path = workspace.to_string_lossy().into_owned();
    prepared.command["context"] = json!({
        "messageContent":"Read proof.txt and answer with its content.",
        "userRef":"user", "profileRefs":[profile_ref],
        "executionPolicy":{"role":"butler","accessMode":"read_only",
            "trackingMode":"none","requiredNativeToolProfiles":[],
            "requiredNativeTools":["read_file","web_search","web_read"],
            "workspacePath":workspace.to_string_lossy()}
    });
    prepared.command["modelSelection"] = json!({"provider":"openai","model":"gpt-5.5",
        "reasoningEffort":"medium","controls":{"accessMode":"read_only"},
        "controlsHash":"smoke"});
    let (turn, _) = documents.load_or_admit(&prepared).await.unwrap();
    let claim = documents.acquire_state_claim(&turn).await.unwrap();
    documents
        .record_model_route_event(ModelRouteEventWrite {
            binding: ModelRouteWrite {
                turn_id: turn.turn_id.clone(),
                expected_revision: turn.revision,
                execution_fence: turn.execution_fence,
                claim_id: claim.claim_id.clone(),
                route: json!({"schemaVersion":"butler.model-route.v1",
            "routeDigest":"a".repeat(64),
            "candidates":[{"modelRef":"openai/gpt-5.5","reasoningEffort":"medium"}],
            "retryCeiling":1,"catalogGeneration":"loopback","activeCursor":0,
            "consumedAttempts":[]}),
            },
            event: json!({"type":"model.route.updated","roundId":"route-state",
                "candidateIndex":0,"modelRef":"openai/gpt-5.5"}),
        })
        .await
        .unwrap();
    let turn = documents.find_turn(&turn.turn_id).await.unwrap().unwrap();

    let files = NativeWorkspaceFiles::new(2);
    let capabilities = Arc::new(NativeCapabilities::new(
        Arc::new(files.clone()),
        Arc::new(WorkspaceMutations::new()),
    ));
    let catalog = Arc::new(NativeGuidedCatalog::load(&capabilities).unwrap());
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: scratch.0.join("sessions.sqlite"),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(SystemIdentity),
    })
    .await
    .unwrap();
    let commands = NativeCommands::new();
    let work = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(storage.clone(), Arc::new(|| "now".into())),
    )));
    let tool_journal = Arc::new(ToolJournalRepository::new(
        storage.clone(),
        Arc::new(|| "now".into()),
    ));
    let subsessions = Arc::new(crate::btcc::NativeSubsessionService::new(
        crate::btcc::SqliteSubsessionRepository::new(storage.clone()),
        bindings.clone(),
        Arc::new(crate::host::runtime::NativeSubsessionQueue(Arc::new(
            crate::gateway::NativeInboundQueue::new(&scratch.0.clone()),
        ))),
        Arc::new(EmptyProfiles),
        work.clone(),
        Arc::new(|| "now".into()),
    ));
    let preparation = NativeGuidedPreparation {
        catalog,
        workspace: NativeSessionWorkspaceRecovery::new(
            bindings.clone(),
            commands.clone(),
            files.clone(),
            Arc::new(HashMap::new()),
        ),
        accepted_plans: NativeAcceptedPlanProducer::new(&scratch.0, 1),
        work,
        authority: Arc::new(crate::btcc::NativePrincipalAuthority::new(
            storage.clone(),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            Arc::new(|| "now".into()),
            Arc::new(|| "uuid".into()),
        )),
        journal: tool_journal.clone(),
        operation_results: Arc::new(crate::btcc::OperationResultRepository::new(
            storage.clone(),
            None,
        )),
        budget: Arc::new(GuidedContinuationBudgetFactory::new(None, Arc::new(|| 0))),
        default_workspace: workspace.to_string_lossy().into_owned(),
        phase_surface_flag: "yes".into(),
        operation_replay_flag: "disabled".into(),
        subsessions: subsessions.clone(),
    };
    let output_models = crate::host::NativeProcessModels::new(
        scratch.0.clone(),
        Default::default(),
        Arc::new(crate::configuration::ConfigurationWrites::new()),
        Arc::new(LocaleCollation::new("en-US").unwrap()),
    )
    .unwrap();
    let profile = Arc::new(crate::profile::ProfileService::new(
        scratch.0.clone(),
        scratch.0.join("cognition"),
        Arc::new(crate::profile::PersonaPresets::new(scratch.0.clone())),
        Arc::new(crate::configuration::ConfigurationWrites::new()),
        Arc::new(
            crate::coordination::CognitionWriteCoordinator::new(Arc::new(SystemIdentity)).unwrap(),
        ),
        Arc::new(SystemIdentity),
        Arc::new(crate::host::ProfileConversationSources::new(
            crate::conversation::conversation_store_path(&scratch.0),
        )),
        output_models.provider.clone(),
    ));
    let tool_output = crate::host::native_tool_output(
        scratch.0.clone(),
        Arc::new(crate::context::ContextBudgetOwner::new(
            output_models.configuration.clone(),
            output_models.catalog.clone(),
            Default::default(),
        )),
        Arc::new(crate::operations::MetricFiles::new(scratch.0.clone())),
    );
    let conversation_store = crate::conversation::AgentConversationStore::open(
        crate::conversation::ConversationStoreConfig {
            path: crate::conversation::conversation_store_path(&scratch.0),
            identity_clock: Arc::new(SystemIdentity),
            collation: Arc::new(LocaleCollation::new("en-US").unwrap()),
        },
    )
    .await
    .unwrap();
    let conversation_tools = Arc::new(crate::context::NativeConversationTools::new(
        scratch.0.clone(),
        Arc::new(crate::context::ContextConversation::new(
            conversation_store.clone(),
            output_models.configuration.clone(),
            output_models.catalog.clone(),
            Default::default(),
        )),
        1,
    ));
    let command = Arc::new(crate::host::guided_command::NativeGuidedCommand::new(
        commands.clone(),
        tool_output.clone(),
        Arc::new(HashMap::new()),
    ));
    let project_tools = Arc::new(
        crate::host::guided_project_tools::NativeGuidedProjectTools::new(
            crate::project_ledger::NativeProjectLedger::new(&scratch.0, 1),
            commands.clone(),
            Arc::new(HashMap::new()),
            crate::work_records::WorkRecordReader::new(&scratch.0),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
        ),
    );
    let work_streams = Arc::new(crate::host::NativeWorkStreams::open(scratch.0.clone()).unwrap());
    let automations = crate::operations::NativeAutomationService::open(
        &scratch.0.clone(),
        crate::operations::AutomationDependencies {
            parse_date: Arc::new(crate::js_date::parse_iso_millis),
            now_millis: Arc::new(|| 0),
            enqueue: Arc::new(crate::host::NativeAutomationQueue(Arc::new(
                crate::gateway::NativeInboundQueue::new(&scratch.0.clone()),
            ))),
            scheduler_interval: std::time::Duration::from_secs(60),
        },
    );
    let factory = NativeGuidedTurnFactory {
        preparation,
        documents: documents.clone(),
        effects: Arc::new(StorageEffectJournal::new(
            storage.clone(),
            Arc::new(|| "now".into()),
        )),
        capabilities,
        command: command.clone(),
        project_tools: project_tools.clone(),
        tool_artifacts: Arc::new(crate::host::NativeToolArtifactReader::new(
            tool_output.clone(),
        )),
        conversation_tools: conversation_tools.clone(),
        memory_query: Arc::new(crate::cognition::NativeExactMemoryQuery::new(
            &scratch.0.clone(),
            1,
        )),
        conversation_reference: Arc::new(crate::context::NativeConversationSessionReference::new(
            &scratch.0.clone(),
            1,
            Arc::new(crate::host::NativeMemorySourceReader::new(
                scratch.0.clone(),
                Default::default(),
            )),
        )),
        memory_recall: Arc::new(crate::cognition::NativeMemoryRecall::new(
            scratch.0.clone(),
            Default::default(),
            Arc::new(crate::js_date::parse_iso_millis),
            Arc::new(std::cmp::Ord::cmp),
            Arc::new(|| 0),
            1,
        )),
        memory_paths: Default::default(),
        memory_publisher: Arc::new(crate::cognition::CompletionPublisher::new(
            &scratch.0.clone(),
            &Default::default(),
            Arc::new(|| "now".into()),
        )),
        compactions: ContextCompactionRepository::new(storage.clone()),
        attachment_context: Arc::new(crate::context::NativeAttachmentContext::new(
            scratch.0.clone(),
        )),
        verified_image_payload: Arc::new(crate::gateway::NativeAppImageFiles::new(
            &scratch.0.clone(),
        )),
        butler_data: scratch.0.clone(),
        installation_root: scratch.0.clone(),
        protected_ledger_roots: vec![],
        subsessions,
        work_streams: work_streams.clone(),
        automations: automations.clone(),
        mcp_client: Arc::new(crate::mcp_client::NativeMcpClient::new(
            scratch.0.clone(),
            HashMap::new(),
        )),
        profile: profile.clone(),
        monitoring: Arc::new(crate::host::MonitoringReaders::new(
            scratch.0.clone(),
            output_models.configuration.clone(),
            output_models.catalog.clone(),
            Arc::new(crate::cognition::MemoryHealthService::new(
                scratch.0.clone(),
                Default::default(),
                Arc::new(
                    crate::coordination::CognitionWriteCoordinator::new(Arc::new(SystemIdentity))
                        .unwrap(),
                ),
            )),
            profile,
            Arc::new(crate::operations::CycleMetrics::new(Arc::new(
                crate::operations::MetricFiles::new(scratch.0.clone()),
            ))),
        )),
        session_worktrees: crate::workspace::NativeSessionWorktrees::new(
            bindings.clone(),
            commands.clone(),
            files.clone(),
            Arc::new(HashMap::new()),
            scratch.0.clone(),
            Arc::new(SystemIdentity),
        ),
        web_access: Arc::new(crate::web_access::tests::access(
            scratch.0.clone(),
            &web_endpoint,
        )),
        app_endpoint: Arc::new(crate::host::NativeActiveAppEndpoint::new()),
    };
    let (endpoint, served) = loopback(&web_page_url).await;
    let model_catalog = Arc::new(ModelCatalog::new().unwrap());
    let snapshot = Arc::new(
        model_catalog
            .snapshot(
                ModelCatalogSnapshotInput {
                    configured_local: vec![],
                    extra_models: vec![],
                    registered_models: vec![],
                    credential_views: vec![],
                    default_model_ref: None,
                    generated_at: "now".into(),
                },
                &LocaleCollation::new("en-US").unwrap(),
            )
            .unwrap(),
    );
    let model = Arc::new(NativeModelProvider::new(
        crate::models::provider_http_client().unwrap(),
        Arc::new(Config { snapshot, endpoint }),
        Arc::new(Observations),
        model_catalog,
        Arc::new(Clock),
        Arc::new(Metrics),
    ));
    let repositories = Arc::new(documents);
    let agent = ProductionAgentLoop::native(
        model,
        Arc::new(TurnModelExecutionFactory::new(
            repositories.clone(),
            ModelRouteRetryConfig::new(0.0),
        )),
        Arc::new(factory),
        None,
    );
    let progress = Progress::default();
    let outcome = tokio::time::timeout(
        Duration::from_secs(15),
        agent.run(
            &turn,
            &claim,
            1,
            &progress,
            &crate::btcc::NOOP_MODEL_ROUND_OBSERVER,
            CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        outcome.content, "The file and public page evidence were read.",
        "{outcome:?}"
    );
    let bodies = tokio::time::timeout(Duration::from_secs(5), served)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bodies.len(), 2);
    assert!(bodies[0].to_string().contains(marker));
    assert!(bodies[1].to_string().contains("native-file-proof"));
    web_server.await.unwrap();
    let journal = tool_journal
        .recent_for_prompt(turn.turn_id.clone())
        .await
        .unwrap();
    assert_eq!(journal.len(), 3);
    let search_record = journal
        .iter()
        .find(|record| record.tool_name == "web_search")
        .unwrap();
    assert_eq!(search_record.status, "completed");
    let search_result = search_record.result.as_ref().unwrap().as_str();
    assert!(search_result.contains("/report"));
    let read_record = journal
        .iter()
        .find(|record| record.tool_name == "web_read")
        .unwrap();
    assert_eq!(read_record.status, "completed");
    let read_result = read_record.result.as_ref().unwrap().as_str();
    assert!(read_result.contains("web-read-turn-proof"));
    assert!(read_result.contains("source_verified"));
    assert!(bodies[1].to_string().contains("web-read-turn-proof"));
    let file_record = journal
        .iter()
        .find(|record| record.tool_name == "read_file")
        .unwrap();
    assert_eq!(file_record.status, "completed");
    assert!(
        file_record
            .result
            .as_ref()
            .unwrap()
            .as_str()
            .contains("native-file-proof")
    );
    {
        let events = progress.0.lock().unwrap();
        assert!(events.iter().any(|event| event.kind == "tool.started"));
        assert!(events.iter().any(|event| event.kind == "tool.completed"));
    }
    repositories.close().await.unwrap();
    bindings.close().await.unwrap();
    project_tools.close().await;
    command.close().await;
    commands.close().await;
    tool_output.close().await;
    conversation_tools.close().await.unwrap();
    conversation_store.close().await.unwrap();
    files.close().await;
    work_streams.close().await.unwrap();
    automations.close().await.unwrap();
}
