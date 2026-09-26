use super::*;

#[tokio::test]
async fn source_bun_budget_documents_match_actual_default_model_estimator() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../source-bun.json")).unwrap();
    for case in cases
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["input"].get("outputMode").is_some())
    {
        let fixture = Fixture::new();
        let input = &case["input"];
        let raw = &input["result"];
        let output_mode = OutputModeInput::Present(input["outputMode"].clone());
        let result = fixture
            .service
            .submit_budget(BudgetToolOutputInput {
                result: ShellCommandResult {
                    stdout: raw["stdout"].as_str().unwrap().into(),
                    stderr: raw["stderr"].as_str().unwrap().into(),
                    exit_code: raw["exit_code"].as_i64().map(|value| value as i32),
                    timed_out: raw["timed_out"].as_bool().unwrap(),
                },
                command: Some("printf".into()),
                cwd: Some("/tmp".into()),
                max_model_tokens: input
                    .get("maxModelTokens")
                    .and_then(serde_json::Value::as_f64),
                output_mode,
                validation_suite: input.get("validationSuite").cloned(),
                retain_original: input
                    .get("retainOriginal")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            })
            .await
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let mut document = result.to_json_document().unwrap();
        if let Some(reference) = &result.butler_tool_artifact {
            document = document
                .replace(reference.path.to_str().unwrap(), "<path>")
                .replace(&reference.id, "<id>");
            let artifact_document = std::fs::read_to_string(&reference.path)
                .unwrap()
                .replace(reference.path.to_str().unwrap(), "<path>")
                .replace(&reference.id, "<id>");
            assert_eq!(
                artifact_document,
                case["artifactDocument"].as_str().unwrap(),
                "{} artifact",
                case["name"]
            );
        }
        assert_eq!(
            document,
            case["document"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        fixture.service.close().await;
    }
}

#[tokio::test]
async fn artifact_directory_write_failure_is_an_error_and_not_a_result() {
    let fixture = Fixture::new();
    std::fs::write(fixture.root.join("artifacts"), b"occupied").unwrap();
    let error = fixture
        .service
        .submit_budget(fixture.budget("retain me", true))
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "tool_output_io_error");
    fixture.service.close().await;
}

#[tokio::test]
async fn empty_command_uses_source_tool_artifact_prefix_but_preserves_command_value() {
    let fixture = Fixture::new();
    let mut input = fixture.budget("retained", true);
    input.command = Some(String::new());
    let output = fixture
        .service
        .submit_budget(input)
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let artifact = output.butler_tool_artifact.unwrap();
    assert!(artifact.id.starts_with("tool_"));
    assert_eq!(artifact.command.as_deref(), Some(""));
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(artifact.path).unwrap()).unwrap();
    assert_eq!(stored["command"], "");
    fixture.service.close().await;
}
