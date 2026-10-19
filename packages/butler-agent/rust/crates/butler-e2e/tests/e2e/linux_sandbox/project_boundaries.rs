//! L1 kernel boundaries, resolved symlinks, hard links, and new-name cleanup.
use super::*;
use std::time::Instant;

fn invoke(command: &str, setup: &Setup) -> Invocation {
    let root = &setup.sandbox.workspace;
    let secrets = command_sandbox::discover_project_secrets(root).unwrap();
    let mut denied: Vec<_> = secrets.iter().map(PathBuf::as_path).collect();
    denied.push(&setup.sandbox.data);
    command_sandbox::project_write_shell(
        command,
        &HashMap::from([("HOME".into(), setup.sandbox.home.display().to_string())]),
        root,
        &[&setup.sandbox.data.join("tmp/project-write")],
        &denied,
        None,
    )
    .unwrap()
}

#[tokio::test]
async fn project_write_kernel_boundaries_and_quarantine() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux project sandbox");
    assert!(command_sandbox::project_write_available());
    let mut setup = Setup::new("LINUX-L1-BOUNDARIES")?;
    let root = &setup.sandbox.workspace;
    for dir in ["src", "sub", "apps/x", ".git"] {
        std::fs::create_dir_all(root.join(dir))?;
    }
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    for name in [".env", "apps/x/.env", ".git/config"] {
        std::fs::write(root.join(name), "protected-marker")?;
    }
    std::fs::write(root.join("top.txt"), "original")?;
    assert!(
        Command::new("mkfifo")
            .arg(root.join("top.pipe"))
            .status()?
            .success()
    );
    let open_pipe =
        r#"python3 -c 'import os; os.close(os.open("top.pipe", os.O_RDWR | os.O_NONBLOCK))'"#;
    let plain = command_sandbox::login_shell(
        open_pipe,
        command_sandbox::ShellAccess::Full,
        &HashMap::new(),
    )
    .unwrap();
    assert!(run(plain, root, &setup.sandbox.home).status.success());
    std::fs::write(root.join("sub/ordinary"), "old-public")?;
    let outside = setup.sandbox.home.join("outside.txt");
    std::fs::write(&outside, "outside-marker")?;
    std::fs::write(setup.sandbox.data.join("ordinary"), "visible-data\n")?;
    butler_platform::secure_fs::symlink(&outside, &root.join("apps/x/private.pem"))?;
    butler_platform::secure_fs::symlink(&outside, &root.join("src/outward"))?;
    let network = std::net::TcpListener::bind("127.0.0.1:0")?;
    network.set_nonblocking(true)?;
    // Tier M masks secrets (reads are empty) and grants the project root;
    // Tier L denies those reads and top-level creation or rewrites.
    let mounted = command_sandbox::capabilities().project_write.is_enforced();
    let root_writes: [String; 5] = [
        "cat .env".into(),
        "echo new > new-top.txt".into(),
        "mkdir new-dir".into(),
        open_pipe.into(),
        "sed -i s/original/changed/ top.txt".into(),
    ];
    for command in root_writes {
        let output = run(invoke(&command, &setup), root, &setup.sandbox.home);
        assert_eq!(output.status.success(), mounted, "{command}: {output:?}");
        assert!(output.stdout.is_empty(), "protected contents escaped");
    }
    let commands = [
        "echo changed > .git/config".into(),
        "rm .env".into(),
        "mv .git sub/git-copy".into(),
        format!("ln '{}' src/outside-link", outside.display()),
        "echo changed > src/outward".into(),
        "cat apps/x/.env".into(),
        "cat apps/x/private.pem".into(),
        "echo changed > apps/x/.env".into(),
        "rm apps/x/.env".into(),
        "python3 -c 'import os; os.setsid()'".into(),
        "python3 -c 'import os; os.setpgid(0, 0)'".into(),
        format!(
            "python3 -c \"import socket; socket.create_connection(('127.0.0.1', {}))\"",
            network.local_addr()?.port()
        ),
    ];
    for command in commands {
        let output = run(invoke(&command, &setup), root, &setup.sandbox.home);
        assert!(!output.status.success(), "{command}: {output:?}");
        assert!(output.stdout.is_empty(), "protected contents escaped");
    }
    for name in [".env", "apps/x/.env", ".git/config"] {
        assert_eq!(
            std::fs::read_to_string(root.join(name))?,
            "protected-marker"
        );
    }
    assert_eq!(std::fs::read_to_string(&outside)?, "outside-marker");
    assert_eq!(
        std::fs::read_to_string(root.join("top.txt"))?,
        if mounted { "changed" } else { "original" }
    );
    assert_eq!(root.join("new-top.txt").exists(), mounted);
    assert!(!root.join("src/outside-link").exists());
    assert_eq!(
        network.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    let workers = r#"python3 -c 'from concurrent.futures import ThreadPoolExecutor; import multiprocessing as m; e=ThreadPoolExecutor(2); assert list(e.map(abs, [-1,-2]))==[1,2]; e.shutdown(); p=m.get_context("fork").Process(target=abs,args=(-3,)); p.start(); p.join(); assert p.exitcode==0'"#;
    let output = run(invoke(workers, &setup), root, &setup.sandbox.home);
    assert!(
        output.status.success(),
        "ordinary threads and forks: {output:?}"
    );
    let since = command_sandbox::discover_project_secrets(root)?;
    let command = format!(
        "set -e; cat '{}'; echo updated > top.txt; echo complete > src/output; mkdir sub/.git; echo planted > sub/.git/config; echo new > sub/.env; mv sub/ordinary sub/renamed.pem; echo scratch > '{}'; {}",
        setup.sandbox.data.join("ordinary").display(),
        setup
            .sandbox
            .data
            .join("tmp/project-write/output")
            .display(),
        // A directory the sweep cannot list must not hide a new secret.
        r#"python3 -c "import os; os.mkdir('sub/hide', 0o300); os.mkdir('sub/hide/.git')""#
    );
    let output = run(invoke(&command, &setup), root, &setup.sandbox.home);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"visible-data\n");
    assert_eq!(std::fs::read_to_string(root.join("top.txt"))?, "updated\n");
    assert_eq!(
        std::fs::read_to_string(setup.sandbox.data.join("tmp/project-write/output"))?,
        "scratch\n"
    );
    let violations = command_sandbox::sweep_new_secrets(root, &since, &setup.sandbox.data)?;
    assert_eq!(
        violations,
        vec![
            root.join("sub/.env"),
            root.join("sub/.git"),
            root.join("sub/hide"),
            root.join("sub/renamed.pem")
        ]
    );
    assert!(!root.join("sub/hide").exists());
    assert!(!root.join("sub/.git").exists());
    assert!(!root.join("sub/.env").exists());
    let quarantine = setup.sandbox.data.join("sandbox-quarantine");
    let run = std::fs::read_dir(quarantine)?.next().unwrap()?.path();
    assert_eq!(
        std::fs::read_to_string(run.join("sub/.git/config"))?,
        "planted\n"
    );
    assert_eq!(std::fs::read_to_string(run.join("sub/.env"))?, "new\n");
    assert_eq!(
        std::fs::read_to_string(run.join("sub/renamed.pem"))?,
        "old-public"
    );
    assert!(
        Command::new("chmod")
            .arg("700")
            .arg(run.join("sub/hide"))
            .status()?
            .success()
    );
    assert!(run.join("sub/hide/.git").is_dir());
    assert_eq!(
        std::fs::read_to_string(root.join("src/output"))?,
        "complete\n"
    );
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn perf_project_secret_discovery_and_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux project sandbox latency"
    );
    let mut setup = Setup::new("LINUX-L1-WALK-LATENCY")?;
    let root = &setup.sandbox.workspace;
    for dir in 0..50 {
        let path = root.join(format!("src/d{dir}"));
        std::fs::create_dir_all(&path)?;
        for file in 0..100 {
            std::fs::write(path.join(format!("f{file}")), "complete")?;
        }
    }
    let protected = root.join("src/d49/.env");
    std::fs::write(&protected, "existing")?;
    let mut discover = Vec::new();
    let mut sweep = Vec::new();
    for index in 0..21 {
        let started = Instant::now();
        let secrets = command_sandbox::discover_project_secrets(root)?;
        discover.push(started.elapsed());
        assert_eq!(secrets, vec![protected.clone()]);
        let since = secrets;
        let planted = root.join(format!("src/d{index}/.key"));
        std::fs::write(&planted, "new")?;
        let started = Instant::now();
        let moved = command_sandbox::sweep_new_secrets(root, &since, &setup.sandbox.data)?;
        sweep.push(started.elapsed());
        assert_eq!(moved, vec![planted.clone()]);
        assert!(!planted.exists());
        assert_eq!(std::fs::read_to_string(&protected)?, "existing");
    }
    discover.sort();
    sweep.sort();
    eprintln!(
        "| Step (5,000 ordinary files) | p50 ms | p95 ms |\n| --- | ---: | ---: |\n| discovery | {:.3} | {:.3} |\n| sweep + quarantine | {:.3} | {:.3} |",
        discover[10].as_secs_f64() * 1000.0,
        discover[19].as_secs_f64() * 1000.0,
        sweep[10].as_secs_f64() * 1000.0,
        sweep[19].as_secs_f64() * 1000.0
    );
    for (step, duration) in [("discovery", discover[19]), ("sweep", sweep[19])] {
        // Micro watch: half of the 20 ms p95 per-tool-call containment overhead budget.
        butler_e2e::assert_wall_clock_budget!(duration, Duration::from_millis(10), step);
    }
    let mut quarantines = std::fs::read_dir(setup.sandbox.data.join("sandbox-quarantine"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    quarantines.sort();
    assert_eq!(quarantines.len(), 21);
    for (index, run) in quarantines.iter().enumerate() {
        assert_eq!(
            std::fs::read_to_string(run.join(format!("src/d{index}/.key")))?,
            "new"
        );
    }
    // Complete tree and content remain intact, including the last directory.
    for dir in 0..50 {
        for file in 0..100 {
            assert_eq!(
                std::fs::read_to_string(root.join(format!("src/d{dir}/f{file}")))?,
                "complete"
            );
        }
    }
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn project_write_cancellation_still_quarantines() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux project sandbox");
    use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};
    use tokio_util::sync::CancellationToken;
    let mut setup = Setup::new("LINUX-L1-CANCEL")?;
    let root = &setup.sandbox.workspace;
    std::fs::create_dir_all(root.join("sub"))?;
    let abort = CancellationToken::new();
    let owner = Commands::new();
    let result = owner
        .submit_guided(GuidedCommandInput {
            command: "mkdir sub/.git; echo complete > sub/.git/config; sleep 30".into(),
            cwd: None,
            workspace_root: root.clone(),
            butler_data: setup.sandbox.data.clone(),
            timeout_ms: Some(30_000.0),
            access: GuidedAccess::ProjectWrite,
            host_environment: HashMap::from([
                ("HOME".into(), setup.sandbox.home.display().to_string()),
                ("PATH".into(), std::env::var("PATH").unwrap()),
            ]),
            abort: abort.clone(),
        })
        .unwrap();
    let ready = root.join("sub/.git/config");
    let reached = tokio::time::timeout(Duration::from_secs(5), async {
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    abort.cancel();
    owner.close().await;
    assert!(reached.is_ok(), "command never created the cleanup fixture");
    assert!(
        result.await.unwrap().is_err(),
        "cancelled command must fail"
    );
    assert!(!root.join("sub/.git").exists());
    let quarantine = std::fs::read_dir(setup.sandbox.data.join("sandbox-quarantine"))?
        .next()
        .unwrap()?
        .path();
    assert_eq!(
        std::fs::read_to_string(quarantine.join("sub/.git/config"))?,
        "complete\n"
    );
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn scratch_grants_do_not_reallow_existing_secret_targets() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux project sandbox");
    let mut setup = Setup::new("LINUX-L1-SCRATCH-SECRET")?;
    let root = setup.sandbox.workspace.clone();
    let scratch = setup.sandbox.data.join("tmp/project-write");
    std::fs::create_dir_all(&scratch)?;
    std::fs::create_dir_all(root.join("src"))?;
    let target = scratch.join("private.txt");
    std::fs::write(&target, "protected-scratch")?;
    butler_platform::secure_fs::symlink(&target, &root.join(".env"))?;
    for command in [
        "cat .env".to_owned(),
        "echo changed > .env".to_owned(),
        format!("cat '{}'", target.display()),
        format!("echo changed > '{}'", target.display()),
    ] {
        let output = run(invoke(&command, &setup), &root, &setup.sandbox.home);
        assert!(!output.status.success(), "{command}: {output:?}");
        assert_eq!(output.stdout, b"", "protected scratch contents escaped");
    }
    assert_eq!(std::fs::read_to_string(target)?, "protected-scratch");
    let output = run(
        invoke("echo complete > src/output", &setup),
        &root,
        &setup.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(root.join("src/output"))?,
        "complete\n"
    );
    // An ordinary private data root may itself be inside the project. Its
    // writable scratch exception must survive the protected-target split.
    setup.sandbox.data = root.join("data");
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let output = run(
        invoke("echo scratch > data/tmp/project-write/output", &setup),
        &root,
        &setup.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(setup.sandbox.data.join("tmp/project-write/output"))?,
        "scratch\n"
    );
    let output = run(
        invoke("echo forbidden > data/core.txt", &setup),
        &root,
        &setup.sandbox.home,
    );
    assert!(!output.status.success());
    assert!(!setup.sandbox.data.join("core.txt").exists());
    setup.sandbox.mark_success();
    Ok(())
}
