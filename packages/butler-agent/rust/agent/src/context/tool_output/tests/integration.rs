use super::*;

#[cfg(unix)]
#[tokio::test]
async fn real_k2_structured_and_guided_outputs_feed_persisted_context_artifacts() {
    use crate::workspace::{
        CommandStep, GuidedAccess, GuidedCommandInput, NativeCommands, StructuredCommandInput,
    };
    use tokio_util::sync::CancellationToken;

    let fixture = Fixture::new();
    let commands = NativeCommands::new();
    let structured = commands
        .submit_structured(StructuredCommandInput {
            steps: vec![CommandStep {
                executable: "/bin/sh".into(),
                arguments: vec!["-c".into(), "printf 'structured'".into()],
            }],
            cwd: Some(fixture.root.clone()),
            environment: HashMap::new(),
            host_environment: HashMap::new(),
            inherit_environment: false,
            stdin: String::new(),
            timeout_ms: None,
            abort: CancellationToken::new(),
            legacy: None,
            test_late_reap: None,
            test_pause_before_second_spawn: None,
        })
        .unwrap()
        .await
        .unwrap();
    assert_eq!(structured.stdout, "structured");
    let persisted = fixture
        .service
        .submit_budget(BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout: structured.stdout,
                stderr: structured.stderr,
                exit_code: structured.exit_code,
                timed_out: structured.timed_out,
            },
            command: Some("printf structured".into()),
            cwd: Some(fixture.root.to_string_lossy().into_owned()),
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
    let ref_path = persisted.butler_tool_artifact.unwrap().path;
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&std::fs::read(&ref_path).unwrap()).unwrap()["result"]
            ["stdout"],
        "structured"
    );
    let reopened = fixture
        .service
        .submit_read(ReadToolOutputInput {
            artifact_id: None,
            path: Some(ref_path),
            stream: ArtifactStream::Stdout,
            offset_lines: None,
            offset_chars: None,
            search: None,
            limit_lines: None,
            max_tokens: None,
            max_artifact_scan_files: None,
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert!(reopened.ok);
    assert_eq!(reopened.stdout.unwrap().text.utf8_lossy(), "structured");

    let mut host_environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
    if let Ok(home) = std::env::var("HOME") {
        host_environment.insert("HOME".into(), home);
    }
    let guided = commands
        .submit_guided(GuidedCommandInput {
            command: "printf guided".into(),
            cwd: None,
            workspace_root: fixture.root.clone(),
            butler_data: fixture.root.clone(),
            timeout_ms: None,
            access: GuidedAccess::FullAccessContained,
            host_environment,
            abort: CancellationToken::new(),
            test_capture_fail_after_first_chunk: false,
            test_late_reap: None,
        })
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let payload = std::fs::read_to_string(&guided.payload_source.path).unwrap();
    let tail = payload.split_once("\n--- stdout ---\n").unwrap().1;
    let (stdout, stderr) = tail.split_once("\n--- stderr ---\n").unwrap();
    assert_eq!(stdout, "guided");
    let conditional = fixture
        .service
        .submit_budget(BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout: stdout.into(),
                stderr: stderr.into(),
                exit_code: guided.summary.exit_code,
                timed_out: guided.summary.timed_out,
            },
            command: Some(guided.summary.command),
            cwd: Some(guided.summary.cwd),
            max_model_tokens: None,
            output_mode: OutputModeInput::Present(serde_json::json!("auto")),
            validation_suite: None,
            retain_original: false,
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert!(conditional.butler_tool_artifact.is_none());
    assert!(
        guided.payload_source.path.exists(),
        "K2 evidence remains owned for later consumer transfer"
    );
    commands.close().await;
    fixture.service.close().await;
}
