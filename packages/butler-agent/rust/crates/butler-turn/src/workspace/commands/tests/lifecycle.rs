use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use butler_platform::command_sandbox;
use butler_platform::process_control::{self, Liveness, liveness};

use super::{
    CommandStep, Commands, Fixture, GuidedAccess, ScriptedProcesses, command_fixtures, shell_step,
};

// test-category: race
#[tokio::test]
async fn capture_write_failure_terminates_child_and_discards_owned_files() {
    let fixture = Fixture::new();
    let owner = Commands::with_host(Arc::new(ScriptedProcesses {
        failing_capture: true,
        ..ScriptedProcesses::default()
    }));
    let input = fixture.guided(command_fixtures::write_then_wait());
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

// test-category: race
#[tokio::test]
async fn close_cancels_running_command_and_rejects_admission() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let receiver = owner
        .submit_guided(fixture.guided(command_fixtures::wait()))
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), owner.close())
        .await
        .unwrap();
    let result = receiver.await.unwrap().unwrap_err();
    assert_eq!(result.code(), "command_cancelled");
    assert_eq!(owner.active_count(), 0);
    assert_eq!(
        owner
            .submit_guided(fixture.guided(command_fixtures::wait()))
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
    sweep_survives_reconciliation_failure().await;
    full_access_helper_markers_remain_ordinary_output().await;
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
        format!("if ($null -eq $env:{name}) {{ 'unset' }} else {{ $env:{name} }}")
    }
}

/// System runtime environment needed to start the native shell.
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
    let expected = "\n--- stdout ---\nunset\n";
    assert!(payload.contains(expected), "{payload}");
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

/// A command containing nested quotes reaches the native shell intact.
async fn guided_quotes_reach_the_shell_intact() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let (command, printed) = if command_sandbox::POSIX_SHELL {
        ("printf %s \"a b\" 'c d'", "a bc d")
    } else {
        (r#"[Console]::Write("a b" + 'c d')"#, "a bc d")
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
// test-category: security
#[tokio::test]
async fn guided_read_only_uses_actual_sandbox_boundary() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    let target = fixture.0.join("must-not-write");
    let mut input = fixture.guided(&command_fixtures::delayed_marker(&target));
    input.access = GuidedAccess::ReadOnlyObservation;
    let result = owner.submit_guided(input).unwrap().await.unwrap();
    if command_sandbox::capabilities().read_only.is_enforced() {
        let output = result.expect("a host with a sandbox runs read-only commands");
        assert_ne!(output.summary.exit_code, Some(0));
    } else {
        let error = result.expect_err("a host without a sandbox refuses read-only commands");
        assert_eq!(error.code(), "command_observation_isolation_unavailable");
    }
    assert!(!target.exists());
    owner.close().await;
}

// test-category: race
#[tokio::test]
async fn guided_forced_public_settlement_precedes_owned_reap() {
    let fixture = Fixture::new();
    let (host, release) = ScriptedProcesses::reaped_on_release();
    let owner = Commands::with_host(Arc::new(host));
    let mut input = fixture.guided(command_fixtures::wait());
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

// test-category: race
#[tokio::test]
async fn structured_forced_public_settlement_precedes_owned_reap() {
    let fixture = Fixture::new();
    let (host, release) = ScriptedProcesses::reaped_on_release();
    let owner = Commands::with_host(Arc::new(host));
    let mut input = fixture.structured(vec![shell_step(command_fixtures::wait())]);
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

// test-category: race
#[tokio::test]
async fn partial_pipeline_spawn_failure_reaps_term_ignoring_descendant() {
    let fixture = Fixture::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let owner = Commands::with_host(Arc::new(ScriptedProcesses {
        before_second_spawn: Some(gate.clone()),
        ..ScriptedProcesses::default()
    }));
    let pid_path = fixture.0.join("partial-child.pid");
    let first = command_fixtures::descendant(&pid_path);
    let mut input = fixture.structured(vec![
        shell_step(&first),
        CommandStep {
            executable: "/definitely/missing/butler-command".into(),
            arguments: vec![],
        },
    ]);
    input.timeout_ms = Some(60_000.0);
    let receiver = owner.submit_structured(input).unwrap();
    let mut pid = None;
    butler_test_support::eventually("the contained descendant to be ready", || {
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

async fn sweep_survives_reconciliation_failure() {
    let fixture = Fixture::new();
    let root = fixture.0.join("project");
    let data = fixture.0.join("data");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(data.join("sandbox")).unwrap();
    let mut input = fixture.guided("unused");
    input.workspace_root = root.clone();
    input.butler_data = data.clone();
    input.access = GuidedAccess::ProjectWrite;
    let prepared = super::super::secret_sweep::before_run(&input)
        .await
        .unwrap();
    std::fs::write(root.join(".env"), "new secret").unwrap();
    std::fs::write(data.join("sandbox/drives"), "not a directory").unwrap();
    if !command_sandbox::POSIX_SHELL {
        assert!(command_sandbox::reconcile_project_write(&data).is_err());
    }
    let owner = Commands::new();
    let command = if command_sandbox::POSIX_SHELL {
        "printf complete"
    } else {
        "Write-Output complete"
    };
    let mut original = fixture.guided(command);
    system_environment(&mut original.host_environment);
    let output = owner
        .submit_guided(original)
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    let payload = output.payload_source.path.clone();
    let result = super::super::secret_sweep::after_run(&input, prepared, Ok(Some(output))).await;
    let output = result.unwrap().unwrap();
    assert_eq!(output.summary.exit_code, Some(0));
    let sweep_supported = command_sandbox::project_write_mechanism() != "seatbelt";
    let expected = if sweep_supported {
        vec![root.join(".env")]
    } else {
        Vec::new()
    };
    assert_eq!(output.summary.sandbox_violation, expected);
    assert!(
        std::fs::read_to_string(payload)
            .unwrap()
            .contains("complete")
    );
    owner.close().await;
    assert_eq!(root.join(".env").exists(), !sweep_supported);
}

async fn full_access_helper_markers_remain_ordinary_output() {
    let fixture = Fixture::new();
    let owner = Commands::new();
    for (marker, code) in [
        ("butler_command_execution_timed_out", 124),
        ("ordinary error", 124),
        ("butler_command_execution_failed", 126),
    ] {
        let command = if command_sandbox::POSIX_SHELL {
            format!("printf '%s\\n' '{marker}' >&2; exit {code}")
        } else {
            format!("[Console]::Error.WriteLine('{marker}'); exit {code}")
        };
        let mut input = fixture.guided(&command);
        system_environment(&mut input.host_environment);
        let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
        assert!(!output.summary.timed_out);
        assert_eq!(output.summary.exit_code, Some(code));
        let payload = std::fs::read_to_string(&output.payload_source.path).unwrap();
        assert!(payload.contains(marker));
        let header: serde_json::Value =
            serde_json::from_str(payload.lines().next().unwrap()).unwrap();
        assert_eq!(header["timedOut"], false);
    }
    owner.close().await;
}
