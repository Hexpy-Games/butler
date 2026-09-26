use std::collections::HashMap;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use super::{
    CommandStep, GuidedAccess, GuidedCommandInput, NativeCommands, StructuredCommandInput,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("butler-native-commands-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn guided(&self, command: &str) -> GuidedCommandInput {
        let mut host_environment = HashMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        if let Ok(home) = std::env::var("HOME") {
            host_environment.insert("HOME".into(), home);
        }
        GuidedCommandInput {
            command: command.into(),
            cwd: None,
            workspace_root: self.0.clone(),
            butler_data: self.0.clone(),
            timeout_ms: None,
            access: GuidedAccess::FullAccessContained,
            host_environment,
            abort: CancellationToken::new(),
            test_capture_fail_after_first_chunk: false,
            test_late_reap: None,
        }
    }
    fn structured(&self, steps: Vec<CommandStep>) -> StructuredCommandInput {
        StructuredCommandInput {
            steps,
            cwd: Some(self.0.clone()),
            environment: HashMap::new(),
            host_environment: HashMap::new(),
            inherit_environment: false,
            stdin: String::new(),
            timeout_ms: None,
            abort: CancellationToken::new(),
            legacy: None,
            test_late_reap: None,
            test_pause_before_second_spawn: None,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn guided_real_process_spool_offsets_and_close() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let output = owner
        .submit_guided(fixture.guided("printf 'out'; printf 'err' >&2"))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let bytes = std::fs::read(&output.payload_source.path).unwrap();
    assert_eq!(output.summary.exit_code, Some(0));
    let oracle: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    let payload = String::from_utf8(bytes).unwrap();
    let stdout_marker = "\n--- stdout ---\n";
    let stderr_marker = "\n--- stderr ---\n";
    let stdout_start = payload.find(stdout_marker).unwrap() + stdout_marker.len();
    let tail = payload.split_once("\n--- stdout ---\n").unwrap().1;
    let (stdout, stderr) = tail.split_once("\n--- stderr ---\n").unwrap();
    let stderr_start = payload.find(stderr_marker).unwrap() + stderr_marker.len();
    assert_eq!(output.payload_source.stdout_start as usize, stdout_start);
    assert_eq!(output.payload_source.stdout_len as usize, stdout.len());
    assert_eq!(output.payload_source.stderr_start as usize, stderr_start);
    assert_eq!(output.payload_source.stderr_len as usize, stderr.len());
    assert_eq!(stdout, oracle["guided"]["payloadTail"][0]);
    assert_eq!(stderr, oracle["guided"]["payloadTail"][1]);
    assert_eq!(
        output.summary.exit_code,
        oracle["guided"]["summary"]["exitCode"]
            .as_i64()
            .map(|value| value as i32)
    );
    assert_eq!(owner.active_count(), 0);
    owner.close().await;
    assert_eq!(
        owner
            .submit_guided(fixture.guided("true"))
            .err()
            .unwrap()
            .code,
        "command_owner_closed"
    );
}

#[test]
fn bun_timer_coercion_oracle_matches_guided_timeout() {
    let oracle: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    for case in oracle["timers"].as_array().unwrap() {
        let input = case[0].as_f64().unwrap();
        let expected = case[1].as_u64().unwrap();
        assert_eq!(
            super::guided::guided_timeout(Some(input)).as_millis(),
            u128::from(expected)
        );
    }
}

#[test]
fn bun_incremental_decoder_oracle_matches_chunk_boundaries() {
    let oracle: serde_json::Value = serde_json::from_str(include_str!("source-bun.json")).unwrap();
    for case in oracle["utf8Chunks"].as_array().unwrap() {
        let mut decoder = super::decode::Utf8Decoder::default();
        let mut text = String::new();
        for chunk in case["chunks"].as_array().unwrap() {
            let bytes: Vec<u8> = chunk
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u8)
                .collect();
            decoder.write(&bytes, &mut text);
        }
        decoder.end(&mut text);
        assert_eq!(text, case["text"]);
    }
}

#[tokio::test]
async fn structured_pipeline_and_stderr_are_real_process_results() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let input = fixture.structured(vec![
        CommandStep {
            executable: "/bin/sh".into(),
            arguments: vec!["-c".into(), "printf 'hello'; printf 'first' >&2".into()],
        },
        CommandStep {
            executable: "/usr/bin/tr".into(),
            arguments: vec!["a-z".into(), "A-Z".into()],
        },
    ]);
    let output = owner.submit_structured(input).unwrap().await.unwrap();
    assert_eq!(output.stdout, "HELLO");
    assert_eq!(output.stderr, "first");
    assert_eq!(output.exit_code, Some(0));
    assert!(!output.timed_out);
    owner.close().await;
}

#[tokio::test]
async fn caller_drop_does_not_cancel_owned_child() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let marker = fixture.0.join("done");
    let command = format!("sleep 0.05; printf x > '{}'", marker.display());
    drop(owner.submit_guided(fixture.guided(&command)).unwrap());
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while owner.active_count() != 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(std::fs::read(&marker).unwrap(), b"x");
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn guided_timeout_reaps_owned_child() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let mut input = fixture.guided("sleep 5");
    input.timeout_ms = Some(10.0);
    let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
    assert!(output.summary.timed_out);
    assert_eq!(output.summary.exit_code, None);
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn structured_utf8_fragments_and_spawn_failure() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let output = owner
        .submit_structured(fixture.structured(vec![CommandStep {
            executable: "/bin/sh".into(),
            arguments: vec![
                "-c".into(),
                "printf '\\342'; sleep 0.02; printf '\\202\\254'".into(),
            ],
        }]))
        .unwrap()
        .await
        .unwrap();
    assert_eq!(output.stdout, "€");
    let failed = owner
        .submit_structured(fixture.structured(vec![CommandStep {
            executable: "/definitely/missing/butler-command".into(),
            arguments: vec![],
        }]))
        .unwrap()
        .await
        .unwrap();
    assert_eq!(failed.error.unwrap().code, "command_spawn_failed");
    assert_eq!(failed.exit_code, None);
    owner.close().await;
}

#[tokio::test]
async fn structured_preabort_and_legacy_pipefail() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let preabort = fixture.structured(vec![CommandStep {
        executable: "/bin/sh".into(),
        arguments: vec!["-c".into(), "exit 3".into()],
    }]);
    preabort.abort.cancel();
    let cancelled = owner.submit_structured(preabort).unwrap().await.unwrap();
    assert!(cancelled.cancelled);
    assert_eq!(cancelled.exit_code, None);
    let mut legacy = fixture.structured(Vec::new());
    legacy.legacy = Some(super::LegacyShell {
        command: "exit 7 | cat".into(),
        pipefail: true,
        read_only_installation_root: None,
    });
    let output = owner.submit_structured(legacy).unwrap().await.unwrap();
    assert_eq!(output.exit_code, Some(7));
    owner.close().await;
}

mod lifecycle;
