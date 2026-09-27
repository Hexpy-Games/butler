use super::*;

#[tokio::test]
async fn source_bun_reader_documents_match_utf16_cursor_search_and_error_branches() {
    let fixture = Fixture::new();
    let source: serde_json::Value =
        serde_json::from_str(include_str!("../source-bun-read.json")).unwrap();
    let original = &source["original"];
    let retained = fixture
        .service
        .submit_budget(BudgetToolOutputInput {
            result: ShellCommandResult {
                stdout: original["stdout"].as_str().unwrap().into(),
                stderr: original["stderr"].as_str().unwrap().into(),
                exit_code: Some(0),
                timed_out: false,
            },
            command: Some("printf".into()),
            cwd: Some("/tmp".into()),
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
    let reference = retained.butler_tool_artifact.unwrap();
    for case in source["results"].as_array().unwrap() {
        let args = &case["args"];
        let path = match args["path"].as_str() {
            Some("artifact") => Some(reference.path.clone()),
            Some("outside") => Some(fixture.root.join("outside.json")),
            _ => None,
        };
        let stream = match args["stream"].as_str() {
            Some("stdout") => ArtifactStream::Stdout,
            Some("stderr") => ArtifactStream::Stderr,
            _ => ArtifactStream::Both,
        };
        let read = fixture
            .service
            .submit_read(ReadToolOutputInput {
                artifact_id: args["artifactId"].as_str().map(|_| reference.id.clone()),
                path,
                stream,
                offset_lines: args["offsetLines"].as_f64(),
                offset_chars: args["offsetChars"].as_f64(),
                search: args["search"].as_str().map(str::to_owned),
                limit_lines: args["limitLines"].as_f64(),
                max_tokens: args["maxTokens"].as_f64(),
                max_artifact_scan_files: None,
            })
            .await
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let document = read
            .to_json_document()
            .unwrap()
            .replace(reference.path.to_str().unwrap(), "<path>")
            .replace(&reference.id, "<id>");
        assert_eq!(
            document,
            case["document"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    fixture.service.close().await;
}

#[tokio::test]
async fn early_return_retained_original_reopen_utf16_and_explicit_prune() {
    let fixture = Fixture::new();
    let early = fixture
        .service
        .submit_budget(fixture.budget("short", false))
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert!(early.butler_tool_artifact.is_none());
    assert!(!fixture.root.join("artifacts/tool-output").exists());
    let retained = fixture
        .service
        .submit_budget(fixture.budget("A🚀B", true))
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let artifact = retained.butler_tool_artifact.as_ref().unwrap();
    assert!(artifact.path.exists());
    let raw: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&artifact.path).unwrap()).unwrap();
    assert_eq!(raw["schema"], "butler.tool-output.v1");
    assert_eq!(raw["result"]["stdout"], "A🚀B");
    let read = fixture
        .service
        .submit_read(ReadToolOutputInput {
            artifact_id: None,
            path: Some(artifact.path.clone()),
            stream: ArtifactStream::Stdout,
            offset_lines: None,
            offset_chars: Some(2.0),
            search: None,
            limit_lines: None,
            max_tokens: Some(50.0),
            max_artifact_scan_files: None,
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert!(read.ok);
    assert!(read.to_json_document().unwrap().contains("\\ude80B"));
    let protected = fixture
        .service
        .submit_prune(PruneToolOutputInput {
            max_age_ms: None,
            max_bytes: Some(0.0),
            protected_paths: vec![artifact.path.clone()],
            record_telemetry: true,
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(protected.deleted, 0);
    assert!(artifact.path.exists());
    let metric: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(fixture.root.join("metrics/tool-output-prune.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(metric["schema"], "butler.tool-output-prune.v1");
    assert_eq!(metric["protectedCount"], 1);
    assert_eq!(metric["rawTextStored"], false);
    let removed = fixture
        .service
        .submit_prune(PruneToolOutputInput {
            max_age_ms: None,
            max_bytes: Some(0.0),
            protected_paths: vec![],
            record_telemetry: false,
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(removed.deleted, 1);
    assert!(!artifact.path.exists());
    fixture.service.close().await;
    assert!(
        fixture
            .service
            .submit_budget(fixture.budget("again", false))
            .await
            .is_err()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reader_enforces_scan_limit_and_realpath_boundary() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let retained = fixture
        .service
        .submit_budget(fixture.budget("one", true))
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let path = retained.butler_tool_artifact.unwrap().path;
    std::fs::write(
        path.with_file_name("other.json"),
        r#"{"id":"other","result":{"stdout":"two"}}"#,
    )
    .unwrap();
    let scan = fixture
        .service
        .submit_read(ReadToolOutputInput {
            artifact_id: Some("cmd_01234567-89a".into()),
            path: None,
            stream: ArtifactStream::Both,
            offset_lines: None,
            offset_chars: None,
            search: None,
            limit_lines: None,
            max_tokens: None,
            max_artifact_scan_files: Some(1),
        })
        .await
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(scan.error, Some("artifact_scan_limit_exceeded"));
    let outside = fixture.root.join("outside.json");
    std::fs::write(&outside, b"{}").unwrap();
    let link = path.with_file_name("escape.json");
    symlink(&outside, &link).unwrap();
    let escaped = fixture
        .service
        .submit_read(ReadToolOutputInput {
            artifact_id: None,
            path: Some(link),
            stream: ArtifactStream::Both,
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
    assert_eq!(escaped.error, Some("unsafe_artifact_path"));
    fixture.service.close().await;
}
