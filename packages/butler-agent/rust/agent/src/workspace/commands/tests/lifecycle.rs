use std::sync::Arc;
use std::time::Duration;

use super::{CommandStep, Fixture, GuidedAccess, NativeCommands, ScriptedProcesses};

#[cfg(unix)]
#[tokio::test]
async fn guided_normal_close_kills_owned_background_descendant() {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let pid_path = fixture.0.join("child.pid");
    let command = format!("sleep 10 & echo $! > '{}'; exit 0", pid_path.display());
    let output = owner
        .submit_guided(fixture.guided(&command))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.summary.exit_code, Some(0));
    let pid: i32 = std::fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    crate::testing::eventually("the owned descendant to exit", || {
        kill(Pid::from_raw(pid), None) == Err(Errno::ESRCH)
    })
    .await;
    owner.close().await;
}

#[tokio::test]
async fn spool_initialization_failure_does_not_start_child() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let spool_parent = fixture.0.join("runtime/btcc");
    std::fs::create_dir_all(&spool_parent).unwrap();
    std::fs::write(spool_parent.join("command-spool"), b"occupied").unwrap();
    let marker = fixture.0.join("started");
    let command = format!("printf x > '{}'", marker.display());
    let failure = owner
        .submit_guided(fixture.guided(&command))
        .unwrap()
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.code, "command_io_failed");
    assert!(!marker.exists());
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn capture_write_failure_terminates_child_and_discards_owned_files() {
    let fixture = Fixture::new();
    let owner = NativeCommands::with_host(Arc::new(ScriptedProcesses {
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
    assert_eq!(failure.code, "command_capture_failed");
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
    let spool = fixture.0.join("runtime/btcc/command-spool");
    assert_eq!(std::fs::read_dir(spool).unwrap().count(), 0);
}

#[tokio::test]
async fn structured_timeout_and_close_reap_children() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let mut timed = fixture.structured(vec![CommandStep {
        executable: "/bin/sh".into(),
        arguments: vec![
            "-c".into(),
            "trap '' TERM; while :; do sleep 1; done".into(),
        ],
    }]);
    timed.timeout_ms = Some(10.0);
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        owner.submit_structured(timed).unwrap().await.unwrap()
    })
    .await
    .unwrap();
    assert!(output.timed_out);
    assert_eq!(output.exit_code, None);
    assert_eq!(owner.active_count(), 0);
    owner.close().await;
}

#[tokio::test]
async fn close_cancels_running_command_and_rejects_admission() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let receiver = owner.submit_guided(fixture.guided("sleep 10")).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), owner.close())
        .await
        .unwrap();
    let result = receiver.await.unwrap().unwrap_err();
    assert_eq!(result.code, "command_cancelled");
    assert_eq!(owner.active_count(), 0);
    assert_eq!(
        owner
            .submit_guided(fixture.guided("true"))
            .err()
            .unwrap()
            .code,
        "command_owner_closed"
    );
}

#[tokio::test]
async fn guided_environment_excludes_non_allowlisted_host_values() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
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

#[tokio::test]
async fn structured_undefined_environment_entry_removes_inherited_value() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
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
    let owner = NativeCommands::new();
    let target = fixture.0.join("must-not-write");
    let mut input = fixture.guided(&format!("printf x > '{}'", target.display()));
    input.access = GuidedAccess::ReadOnlyObservation;
    let output = owner.submit_guided(input).unwrap().await.unwrap().unwrap();
    assert_ne!(output.summary.exit_code, Some(0));
    assert!(!target.exists());
    owner.close().await;
}

#[tokio::test]
async fn guided_forced_public_settlement_precedes_owned_reap() {
    let fixture = Fixture::new();
    let (host, release) = ScriptedProcesses::reaped_on_release();
    let owner = NativeCommands::with_host(Arc::new(host));
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
async fn assert_close_waits_for_reap(
    owner: &NativeCommands,
    release: tokio::sync::watch::Sender<bool>,
) {
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
    let owner = NativeCommands::with_host(Arc::new(host));
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

#[cfg(unix)]
#[tokio::test]
async fn partial_pipeline_spawn_failure_reaps_term_ignoring_descendant() {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    let fixture = Fixture::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    let owner = NativeCommands::with_host(Arc::new(ScriptedProcesses {
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
    crate::testing::eventually("the TERM-ignoring descendant", || {
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
    assert_eq!(result.error.unwrap().code, "command_spawn_failed");
    crate::testing::eventually("the descendant to be reaped", || {
        kill(Pid::from_raw(pid), None) == Err(Errno::ESRCH)
    })
    .await;
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}
