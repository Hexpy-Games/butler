use super::{CommandStep, Fixture, GuidedAccess, NativeCommands};

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
    let gone = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if kill(Pid::from_raw(pid), None) == Err(Errno::ESRCH) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(gone.is_ok(), "owned descendant {pid} still exists");
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
    let owner = NativeCommands::new();
    let mut input = fixture.guided("printf x; sleep 5");
    input.test_capture_fail_after_first_chunk = true;
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
    let owner = NativeCommands::new();
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let mut input = fixture.guided("trap '' TERM; while :; do sleep 1; done");
    input.timeout_ms = Some(10.0);
    input.test_late_reap = Some(gate.clone());
    let receiver = owner.submit_guided(input).unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), receiver)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(output.summary.timed_out);
    assert_eq!(owner.active_count(), 1);
    let closing = tokio::spawn({
        let owner = owner.clone();
        async move { owner.close().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(!closing.is_finished());
    gate.notify_one();
    closing.await.unwrap();
    assert_eq!(owner.active_count(), 0);
}

#[tokio::test]
async fn structured_forced_public_settlement_precedes_owned_reap() {
    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let mut input = fixture.structured(vec![CommandStep {
        executable: "/bin/sh".into(),
        arguments: vec![
            "-c".into(),
            "trap '' TERM; while :; do sleep 1; done".into(),
        ],
    }]);
    input.timeout_ms = Some(10.0);
    input.test_late_reap = Some(gate.clone());
    let receiver = owner.submit_structured(input).unwrap();
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), receiver)
        .await
        .unwrap()
        .unwrap();
    assert!(output.timed_out);
    assert_eq!(owner.active_count(), 1);
    let closing = tokio::spawn({
        let owner = owner.clone();
        async move { owner.close().await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert!(!closing.is_finished());
    gate.notify_one();
    closing.await.unwrap();
    assert_eq!(owner.active_count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn partial_pipeline_spawn_failure_reaps_term_ignoring_descendant() {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;

    let fixture = Fixture::new();
    let owner = NativeCommands::new();
    let pid_path = fixture.0.join("partial-child.pid");
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let first = format!(
        "sh -c 'trap \"\" TERM; exec sleep 10' & echo $! > '{}'; trap 'exit 0' TERM; wait",
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
    input.test_pause_before_second_spawn = Some(gate.clone());
    let receiver = owner.submit_structured(input).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !pid_path.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let pid: i32 = std::fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    gate.notify_one();
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), receiver)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.error.unwrap().code, "command_spawn_failed");
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while kill(Pid::from_raw(pid), None) != Err(Errno::ESRCH) {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    owner.close().await;
    assert_eq!(owner.active_count(), 0);
}
