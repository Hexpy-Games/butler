use std::{path::PathBuf, sync::Arc, time::SystemTime};

use serde_json::json;

use super::NativeToolArtifactReader;
use crate::{
    configuration::ConfigurationWrites,
    context::{
        BudgetToolOutputInput, ContextBudgetEnvironment, ContextBudgetOwner, OutputModeInput,
        ShellCommandResult, ToolOutputIdentity,
    },
    locale::LocaleCollation,
    models::{
        ModelCatalog, ModelConfiguration, ModelConfigurationClock, ModelConfigurationEnvironment,
    },
};

struct Clock;
impl ModelConfigurationClock for Clock {
    fn now_iso(&self) -> String {
        "2026-09-20T00:00:00.000Z".into()
    }
    fn now_epoch_millis(&self) -> i64 {
        1_790_000_000_000
    }
}
impl ToolOutputIdentity for Clock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
    fn uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

fn service(root: PathBuf) -> crate::context::NativeToolOutput {
    let catalog = Arc::new(ModelCatalog::new().unwrap());
    let configuration = Arc::new(
        ModelConfiguration::new(
            root.clone(),
            ModelConfigurationEnvironment::default(),
            Arc::new(Clock),
            catalog.clone(),
            Arc::new(LocaleCollation::new("en-US").unwrap()),
            crate::models::provider_http_client().unwrap(),
            Arc::new(ConfigurationWrites::new()),
        )
        .unwrap(),
    );
    let budget = Arc::new(ContextBudgetOwner::new(
        configuration,
        catalog,
        ContextBudgetEnvironment::default(),
    ));
    crate::context::NativeToolOutput::new(
        root.clone(),
        budget,
        Arc::new(Clock),
        Arc::new(crate::operations::MetricFiles::new(root)),
    )
}

#[tokio::test]
async fn retained_command_artifact_and_source_evidence_read_exact_utf16() {
    let root =
        std::env::temp_dir().join(format!("butler-native-artifact-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let owner = service(root.clone());
    let retained = owner
        .submit_budget(BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout: "A😀B".into(),
                stderr: String::new(),
                exit_code: Some(0),
                timed_out: false,
            },
            command: Some("printf".into()),
            cwd: None,
            max_model_tokens: None,
            output_mode: OutputModeInput::Present(serde_json::json!("auto")),
            validation_suite: None,
            retain_original: true,
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let path = retained.butler_tool_artifact.unwrap().path;
    let tools = NativeToolArtifactReader::new(owner.clone());
    let output = tools
        .read_output(json!({"path":path,"stream":"stdout","offset_chars":2,"max_tokens":50}))
        .await
        .unwrap();
    assert!(
        output.as_str().contains("\\ude00"),
        "UTF-16 low surrogate must survive JSON wire"
    );
    let evidence = std::env::var("BUTLER_TEST_EVIDENCE_ARTIFACT").ok();
    if let Some(source_path) = evidence {
        let source_root = std::path::Path::new(&source_path)
            .ancestors()
            .nth(4)
            .unwrap();
        let source_service = service(source_root.to_path_buf());
        let source_tools = NativeToolArtifactReader::new(source_service.clone());
        let document = source_tools
            .read_evidence(json!({"path":source_path,"offset_chars":2,"max_tokens":50}))
            .await
            .unwrap();
        assert!(
            document.as_str().contains("\\ude00"),
            "source evidence slice must retain UTF-16 unit"
        );
        source_service.close().await;
    }
    owner.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
