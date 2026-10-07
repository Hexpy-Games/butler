use super::*;
use serde_json::Map;

/// Pure-logic table: context budget precedence, numeric strings, model
/// metadata and thresholds match the source rules.
// test-category: pure-logic
#[tokio::test]
async fn budget_precedence_numeric_strings_metadata_and_thresholds_match_source() {
    let root = temp("budget");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        root.join("butler.config.json"),
        r#"{"system":{"contextWindowTokens":11111,"contextWindowTokensByModel":{"local/sample":12222},"contextReservedOutputTokens":1300,"contextReservedToolTokens":1400},"models":{"local":[{"model_id":"sample","server_url":"http://localhost:8000","context_window_tokens":15555}]}}"#,
    ).unwrap();
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let locale = Arc::new(LocaleCollation::new("en-US").unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.clone(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock::new()),
            catalog.clone(),
            locale,
            butler_models::models::provider_http_client().unwrap(),
            Arc::new(butler_core::configuration::ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let configured_owner = ContextBudgetOwner::new(
        configuration.clone(),
        catalog.clone(),
        ContextBudgetEnvironment::default(),
    );
    let configured = configured_owner.snapshot().await.unwrap();
    assert_eq!(
        configured
            .resolve(Some("local/sample"), &ContextBudgetOverrides::default())
            .context_window_tokens,
        12222.0
    );
    drop(configured);
    let owner = ContextBudgetOwner::new(
        configuration.clone(),
        catalog.clone(),
        ContextBudgetEnvironment {
            context_window_tokens: Some("0x4000".into()),
            reserved_output_tokens: Some("2048".into()),
            reserved_tool_tokens: None,
            compaction_prompt_reserve_tokens: Some("0o2000".into()),
        },
    );
    let snapshot = owner.snapshot().await.unwrap();
    let base = snapshot.resolve(Some("local/sample"), &ContextBudgetOverrides::default());
    assert_eq!(base.context_window_tokens, 15555.0); // catalog is a physical capacity ceiling
    assert_eq!(base.reserved_output_tokens, 2048.0);
    assert_eq!(base.reserved_tool_tokens, 1400.0);
    let overrides = ContextBudgetOverrides {
        context_window_tokens: Some(json!(32768)),
        reserved_output_tokens: None,
        reserved_tool_tokens: None,
        model_windows: Some(Map::from_iter([("local/sample".into(), json!(24576))])),
    };
    assert_eq!(
        snapshot
            .resolve(Some("local/sample"), &overrides)
            .context_window_tokens,
        15555.0
    );
    let evaluation = snapshot.evaluate(Some("local/sample"), 10889.6, &overrides);
    assert_eq!(evaluation.input_tokens, 10889.0);
    assert_eq!(evaluation.threshold_state, ContextThresholdState::Warning);
    assert_eq!(evaluation.pressure_level, ContextPressureLevel::Medium);
    let compact = snapshot.evaluate(Some("local/sample"), 12445.0, &overrides);
    assert_eq!(compact.threshold_state, ContextThresholdState::AutoCompact);
    let hard = snapshot.evaluate(Some("local/sample"), 14000.0, &overrides);
    assert_eq!(hard.threshold_state, ContextThresholdState::HardPressure);
    let working = snapshot.evaluate_working(&WorkingContextBudgetInput {
        model_ref: Some("local/sample".into()),
        working_context_tokens: 20000.9,
        static_context_tokens: Some(10.9),
        live_configuration_tokens: Some(20.9),
        runtime_state_tokens: Some(30.9),
        compaction_prompt_reserve_tokens: None,
        overrides,
    });
    assert_eq!(working.compaction_prompt_reserve_tokens, 1024.0);
    assert!(working.usable_user_message_tokens > 0.0);
    assert_eq!(
        snapshot.default_recent_conversation_token_budget(Some("local/sample")),
        2000.0
    );
    quality::verify(&snapshot);
    drop(snapshot);
    std::fs::write(root.join("butler.config.json"),r#"{"models":{"local":[{"model_id":"sample","server_url":"http://localhost:8000","context_window_tokens":15555}]}}"#).unwrap();
    let metadata = configured_owner.snapshot().await.unwrap();
    assert_eq!(metadata.models.view().default_model_ref, "local/sample");
    assert_eq!(
        metadata
            .resolve(None, &ContextBudgetOverrides::default())
            .context_window_tokens,
        15555.0
    );
    drop(metadata);
    let _ = std::fs::remove_dir_all(root);
}
