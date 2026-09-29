use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use butler_platform::command_sandbox;
use butler_platform::process_control::{self, Liveness, liveness};

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

#[tokio::test]
async fn close_cancels_running_command_and_rejects_admission() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let receiver = owner.submit_guided(fixture.guided("sleep 10")).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), owner.close())
        .await
        .unwrap();
    let result = receiver.await.unwrap().unwrap_err();
    assert_eq!(result.code(), "command_cancelled");
    assert_eq!(owner.active_count(), 0);
    assert_eq!(
        owner
            .submit_guided(fixture.guided("true"))
            .err()
            .unwrap()
            .code(),
        "command_owner_closed"
    );
}

/// Security boundary: commands see only the allowlisted host environment. A
/// guided command never sees a private host value, and a structured step's
/// undefined entry removes an inherited one.
// test-category: security
#[tokio::test]
async fn command_environment_excludes_host_values() {
    guided_environment_excludes_non_allowlisted_host_values().await;
    structured_undefined_environment_entry_removes_inherited_value().await;
    guided_quotes_reach_the_shell_intact().await;
}

/// What a POSIX shell or `cmd.exe` prints for an unset variable: the empty
/// default, or the literal `%NAME%`.
fn unset_marker(name: &str) -> String {
    if command_sandbox::POSIX_SHELL {
        "unset".into()
    } else {
        format!("%{name}%")
    }
}

/// The command that prints `name`'s value in the host's shell.
fn print_variable(name: &str) -> String {
    if command_sandbox::POSIX_SHELL {
        format!("printf %s \"${{{name}-unset}}\"")
    } else {
        format!("echo %{name}%")
    }
}

/// Program files `cmd.exe` needs to start, which the allowlist keeps.
fn system_environment(input: &mut HashMap<String, String>) {
    for name in process_control::SYSTEM_ENVIRONMENT {
        if let Some(value) = std::env::var_os(name) {
            input.insert((*name).into(), value.to_string_lossy().into_owned());
        }
    }
}

async fn guided_environment_excludes_non_allowlisted_host_values() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let mut input = fixture.guided(&print_variable("PRIVATE_TOKEN"));
    system_environment(&mut input.host_environment);
    input
        .host_environment
        .insert("PRIVATE_TOKEN".into(), "secret".into());
    let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
    let payload = std::fs::read_to_string(output.payload_source.path)
        .unwrap()
        .replace("\r\n", "\n");
    let expected = format!("\n--- stdout ---\n{}\n", unset_marker("PRIVATE_TOKEN"));
    assert!(payload.contains(&expected), "{payload}");
    assert!(!payload.contains("secret"));
    owner.close().await;
}

async fn structured_undefined_environment_entry_removes_inherited_value() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let (executable, arguments) = if command_sandbox::POSIX_SHELL {
        (
            "/bin/sh".to_owned(),
            vec![
                "-c".to_owned(),
                "printf %s \"${BUTLER_ORACLE_ENV-unset}\"".to_owned(),
            ],
        )
    } else {
        (
            "cmd.exe".to_owned(),
            ["/d", "/c", "echo", "%BUTLER_ORACLE_ENV%"]
                .map(str::to_owned)
                .to_vec(),
        )
    };
    let mut input = fixture.structured(vec![CommandStep {
        executable,
        arguments,
    }]);
    input.inherit_environment = true;
    system_environment(&mut input.host_environment);
    input
        .host_environment
        .insert("BUTLER_ORACLE_ENV".into(), "present".into());
    input.environment.insert("BUTLER_ORACLE_ENV".into(), None);
    let output = owner.submit_structured(input).unwrap().await.unwrap();
    assert_eq!(output.stdout.trim_end(), unset_marker("BUTLER_ORACLE_ENV"));
    owner.close().await;
}

/// A command containing quotes reaches the shell as written: `cmd.exe` does
/// not undo the `\"` escaping of `Command::arg`.
async fn guided_quotes_reach_the_shell_intact() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let (command, printed) = if command_sandbox::POSIX_SHELL {
        ("printf %s \"a b\" 'c d'", "a bc d")
    } else {
        ("echo \"a b\" \"c d\"", "\"a b\" \"c d\"")
    };
    let mut input = fixture.guided(command);
    system_environment(&mut input.host_environment);
    let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
    let payload = std::fs::read_to_string(output.payload_source.path)
        .unwrap()
        .replace("\r\n", "\n");
    let expected = format!("\n--- stdout ---\n{printed}\n");
    assert!(payload.contains(&expected), "{payload}");
    owner.close().await;
}

/// A read-only command cannot write. A host with a sandbox must run it
/// there, where the write fails; a host without one must refuse it.
#[tokio::test]
async fn guided_read_only_uses_actual_sandbox_boundary() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let target = fixture.0.join("must-not-write");
    let mut input = fixture.guided(&format!("printf x > '{}'", target.display()));
    input.access = GuidedAccess::ReadOnlyObservation;
    let result = owner.submit_guided(input).unwrap().await.unwrap();
    if command_sandbox::READ_ONLY_SANDBOX {
        let output = result.expect("a host with a sandbox runs read-only commands");
        assert_ne!(output.summary.exit_code, Some(0));
    } else {
        let error = result.expect_err("a host without a sandbox refuses read-only commands");
        assert_eq!(error.code(), "command_observation_isolation_unavailable");
    }
    assert!(!target.exists());
    owner.close().await;
}

#[tokio::test]
async fn guided_forced_public_settlement_precedes_owned_reap() {
    let fixture = Fixture::new();
    let (host, release) = ScriptedProcesses::reaped_on_release();
    let owner = Commands::with_host(Arc::new(host));
    let mut input = fixture.guided("while :; do sleep 1; done");
    input.timeout_ms = Some(10.0);
    let receiver = owner.submit_guided(input).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(output.summary.timed_out);
    assert_eq!(owner.active_count(), 1);
    assert_close_waits_for_reap(&owner, release).await;
}

/// The public result is already settled; closing the owner must still wait
/// until the killed child is reaped.
async fn assert_close_waits_for_reap(owner: &Commands, release: tokio::sync::watch::Sender<bool>) {
    let mut closing = tokio::spawn({
        let owner = owner.clone();
        async move { owner.close().await }
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut closing)
            .await
            .is_err(),
        "close finished before the owned child was reaped"
    );
    release.send(true).unwrap();
    closing.await.unwrap();
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn structured_forced_public_settlement_precedes_owned_reap() {
    let fixture = Fixture::new();
    let (host, release) = ScriptedProcesses::reaped_on_release();
    let owner = Commands::with_host(Arc::new(host));
    let mut input = fixture.structured(vec![CommandStep {
        executable: "/bin/sh".into(),
        arguments: vec!["-c".into(), "while :; do sleep 1; done".into()],
    }]);
    input.timeout_ms = Some(10.0);
    let receiver = owner.submit_structured(input).unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .unwrap()
        .unwrap();
    assert!(output.timed_out);
    assert_eq!(owner.active_count(), 1);
    assert_close_waits_for_reap(&owner, release).await;
}

#[tokio::test]
async fn partial_pipeline_spawn_failure_reaps_term_ignoring_descendant() {
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
            .and_then(|pid| pid.trim().parse::<u32>().ok());
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
        liveness(pid) == Liveness::Gone
    })
    .await;
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}
