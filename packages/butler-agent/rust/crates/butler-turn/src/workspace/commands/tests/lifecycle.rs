use std::sync::Arc;
use std::time::Duration;

use super::{CommandStep, Commands, Fixture, GuidedAccess, ScriptedProcesses};

#[tokio::test]
async fn capture_write_failure_terminates_child_and_discards_owned_files() {
    let fixture = Fixture::new();
    let owner = Commands::with_host(Arc::new(ScriptedProcesses {
        failing_capture: true,
        ..ScriptedProcesses::default()
    }));
    let input = fixture.guided("printf x; sleep 5");
    let failure = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        owner
            .submit_guided(input)
            .unwrap()
            .await
            .unwrap()
            .unwrap_err()
    })
    .await
    .unwrap();
    assert_eq!(failure.code(), "command_capture_failed");
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
    let spool = fixture.0.join("runtime/btcc/command-spool");
    assert_eq!(std::fs::read_dir(spool).unwrap().count(), 0);
}

/// Security boundary: commands see only the allowlisted host environment. A
/// guided command never sees a private host value, and a structured step's
/// undefined entry removes an inherited one.
// test-category: security
#[tokio::test]
async fn command_environment_excludes_host_values() {
    guided_environment_excludes_non_allowlisted_host_values().await;
    structured_undefined_environment_entry_removes_inherited_value().await;
}

async fn guided_environment_excludes_non_allowlisted_host_values() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let mut input = fixture.guided("printf %s \"${PRIVATE_TOKEN-unset}\"");
    input
        .host_environment
        .insert("PRIVATE_TOKEN".into(), "secret".into());
    let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
    let payload = std::fs::read_to_string(output.payload_source.path).unwrap();
    assert!(payload.contains("\n--- stdout ---\nunset\n--- stderr ---\n"));
    assert!(!payload.contains("secret"));
    owner.close().await;
}

async fn structured_undefined_environment_entry_removes_inherited_value() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let mut input = fixture.structured(vec![CommandStep {
        executable: "/bin/sh".into(),
        arguments: vec![
            "-c".into(),
            "printf %s \"${BUTLER_ORACLE_ENV-unset}\"".into(),
        ],
    }]);
    input.inherit_environment = true;
    input
        .host_environment
        .insert("BUTLER_ORACLE_ENV".into(), "present".into());
    input.environment.insert("BUTLER_ORACLE_ENV".into(), None);
    let output = owner.submit_structured(input).unwrap().await.unwrap();
    assert_eq!(output.stdout, "unset");
    owner.close().await;
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn guided_read_only_uses_actual_sandbox_boundary() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let target = fixture.0.join("must-not-write");
    let mut input = fixture.guided(&format!("printf x > '{}'", target.display()));
    input.access = GuidedAccess::ReadOnlyObservation;
    let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
    assert_ne!(output.summary.exit_code, Some(0));
    assert!(!target.exists());
    owner.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn partial_pipeline_spawn_failure_reaps_term_ignoring_descendant() {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    let fixture = Fixture::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let owner = Commands::with_host(Arc::new(ScriptedProcesses {
        before_second_spawn: Some(gate.clone()),
        ..ScriptedProcesses::default()
    }));
    let pid_path = fixture.0.join("partial-child.pid");
    // The descendant reports its pid only after it ignores SIGTERM; the file
    // appears atomically so the test never reads a partial write.
    let first = format!(
        "sh -c 'trap \"\" TERM; echo $$ > \"$0.tmp\"; mv \"$0.tmp\" \"$0\"; exec sleep 10' '{}' & \
         trap 'exit 0' TERM; wait",
        pid_path.display()
    );
    let mut input = fixture.structured(vec![
        CommandStep {
            executable: "/bin/sh".into(),
            arguments: vec!["-c".into(), first],
        },
        CommandStep {
            executable: "/definitely/missing/butler-command".into(),
            arguments: vec![],
        },
    ]);
    input.timeout_ms = Some(60_000.0);
    let receiver = owner.submit_structured(input).unwrap();
    let mut pid = None;
    butler_test_support::eventually("the TERM-ignoring descendant", || {
        pid = std::fs::read_to_string(&pid_path)
            .ok()
            .and_then(|pid| pid.trim().parse::<i32>().ok());
        pid.is_some()
    })
    .await;
    let pid = pid.unwrap();
    gate.notify_one();
    let result = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.error.unwrap().code(), "command_spawn_failed");
    butler_test_support::eventually("the descendant to be reaped", || {
        kill(Pid::from_raw(pid), None) == Err(Errno::ESRCH)
    })
    .await;
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}
