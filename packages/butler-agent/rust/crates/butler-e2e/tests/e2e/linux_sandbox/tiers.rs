//! Uniform project-write boundaries and literal declaration recovery.
use super::*;
use std::time::Instant;

fn invoke(command: &str, root: &Path, setup: &Setup) -> Invocation {
    command_sandbox::project_write_shell(
        command,
        &HashMap::from([("HOME".into(), setup.sandbox.home.display().to_string())]),
        root,
        &[&setup.sandbox.data.join("tmp/project-write")],
        &[&setup.sandbox.data],
    )
    .unwrap()
}

#[tokio::test]
async fn uniform_project_write_tier_matrix() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux tier matrix");
    let mut setup = Setup::new("LINUX-TIER-MATRIX")?;
    let root = setup.sandbox.workspace.clone();
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let mounted = command_sandbox::capabilities().project_write.is_enforced();
    eprintln!("Tier matrix: {}", if mounted { "M" } else { "L" });
    for dir in ["config", ".git/hooks", "sub"] {
        std::fs::create_dir_all(root.join(dir))?;
    }
    for name in [".env", "config/.env", ".git/config"] {
        std::fs::write(root.join(name), "protected")?;
    }
    std::fs::write(root.join("package.json"), "original")?;
    std::fs::write(setup.sandbox.home.join(".bashrc"), "outside")?;
    let mountinfo = std::fs::read("/proc/self/mountinfo")?;
    let nested = run(
        invoke("cat .env", &root, &setup),
        &root.join("config"),
        &setup.sandbox.home,
    );
    assert!(
        nested.stdout.is_empty(),
        "old cwd bypassed mask: {nested:?}"
    );
    for alias in command_sandbox::project_mount_aliases(&root)? {
        let output = run(
            invoke(
                &format!("cat '{}/config/.env'", alias.display()),
                &root,
                &setup,
            ),
            &root,
            &setup.sandbox.home,
        );
        assert!(
            output.stdout.is_empty(),
            "mount alias exposed secret: {output:?}"
        );
    }
    let mut directory_listing_leaked = false;
    for command in ["cat .env", "head config/.env", "cat .git/config", "ls .git"] {
        let output = run(invoke(command, &root, &setup), &root, &setup.sandbox.home);
        if command == "ls .git" && !mounted {
            directory_listing_leaked = !output.stdout.is_empty();
        } else {
            assert!(output.stdout.is_empty(), "{command}: {output:?}");
        }
    }
    for command in [
        "echo overwrite > .env",
        "truncate -s 0 .env",
        "rm .env",
        "mv .env public",
        "rm -rf .git",
        "mv config moved",
        "ln package.json .git/hooks/x",
        "ln -s /tmp .git/hooks/x",
        "umount .git",
        "unshare -r true",
        "chmod 777 ~/.bashrc",
        "cd ..; chmod 777 home/.bashrc",
    ] {
        let output = run(invoke(command, &root, &setup), &root, &setup.sandbox.home);
        assert!(!output.status.success(), "{command}: {output:?}");
    }
    let policy: Value = serde_json::from_str(&invoke("true", &root, &setup).arguments[1])?;
    let plus = policy["mountns_plus"] == true;
    for command in ["chmod +x package.json", "touch package.json"] {
        let output = run(invoke(command, &root, &setup), &root, &setup.sandbox.home);
        assert_eq!(output.status.success(), plus, "{command}: {output:?}");
    }
    for name in [".env", "config/.env", ".git/config"] {
        assert_eq!(std::fs::read_to_string(root.join(name))?, "protected");
    }
    for command in [
        "sed -i s/original/changed/ package.json",
        "echo atomic > lock.tmp && mv lock.tmp lockfile",
        "touch NEW",
    ] {
        let output = run(invoke(command, &root, &setup), &root, &setup.sandbox.home);
        assert_eq!(output.status.success(), mounted, "{command}: {output:?}");
    }
    std::fs::write(
        root.join(".gitignore"),
        "node_modules\n/target\n.venv/\nempty/\n!negated\n*.pem\na/b\n.env\n",
    )?;
    command_sandbox::prepare_project_write(&root, &setup.sandbox.data)?;
    for name in ["node_modules", "target", ".venv"] {
        let command = format!("mkdir -p {name}; echo complete > {name}/output");
        let output = run(invoke(&command, &root, &setup), &root, &setup.sandbox.home);
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            std::fs::read_to_string(root.join(name).join("output"))?,
            "complete\n"
        );
    }
    assert!(!root.join("negated").exists());
    let since = command_sandbox::discover_project_secrets(&root)?;
    let command = if mounted {
        "echo new > .env.new; echo nested > sub/.env"
    } else {
        "echo nested > sub/.env"
    };
    let output = run(invoke(command, &root, &setup), &root, &setup.sandbox.home);
    assert!(output.status.success(), "{output:?}");
    let moved = command_sandbox::sweep_new_secrets(&root, &since, &setup.sandbox.data)?;
    assert_eq!(moved.len(), if mounted { 2 } else { 1 });
    assert!(!root.join("empty").exists());
    assert!(!root.join("sub/.env").exists());
    assert_eq!(std::fs::read("/proc/self/mountinfo")?, mountinfo);
    let alias = setup.sandbox.home.join("project-alias");
    butler_platform::secure_fs::symlink(&root, &alias)?;
    let output = run(
        invoke("echo alias > sub/alias-output", &alias, &setup),
        &alias,
        &setup.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(root.join("sub/alias-output"))?,
        "alias\n"
    );
    assert!(
        !directory_listing_leaked,
        "Tier L1 READ_DIR exposes secret directory names; the specification also requires retaining its read complement"
    );
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn generated_directory_crash_recovery_and_top_level_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux declaration recovery"
    );
    let mut setup = Setup::new("LINUX-GENERATED-RECOVERY")?;
    let root = &setup.sandbox.workspace;
    std::fs::write(root.join(".gitignore"), "empty\nkept\n")?;
    command_sandbox::prepare_project_write(root, &setup.sandbox.data)?;
    if !command_sandbox::capabilities().project_write.is_enforced() {
        std::fs::write(root.join("kept/output"), "complete")?;
        let journals = setup.sandbox.data.join("sandbox-generated");
        let dir = std::fs::read_dir(journals)?.next().unwrap()?.path();
        let journal = std::fs::read_dir(&dir)?
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
            })
            .unwrap()
            .path();
        std::fs::rename(journal, dir.join("2147483647.json"))?;
        std::fs::write(root.join(".gitignore"), "")?;
        command_sandbox::prepare_project_write(root, &setup.sandbox.data)?;
        assert!(!root.join("empty").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("kept/output"))?,
            "complete"
        );
    }
    let before = command_sandbox::discover_project_secrets(root)?;
    // Cleanup must include depth zero even on L (e.g. externally planted names).
    std::fs::write(root.join(".env"), "top")?;
    std::fs::create_dir(root.join(".git"))?;
    std::fs::write(root.join(".git/config"), "new-repository")?;
    let moved = command_sandbox::sweep_new_secrets(root, &before, &setup.sandbox.data)?;
    assert_eq!(moved, vec![root.join(".env"), root.join(".git")]);
    assert!(!root.join(".env").exists() && !root.join(".git").exists());
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn perf_five_thousand_secret_mounts_and_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux secret mount latency"
    );
    let mut setup = Setup::new("LINUX-SECRET-MOUNTS")?;
    let root = &setup.sandbox.workspace;
    std::fs::create_dir_all(root.join("node_modules"))?;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    for index in 0..5000 {
        std::fs::write(root.join(format!("node_modules/{index}.pem")), "protected")?;
    }
    let mut setup_times = Vec::new();
    let mut teardown_times = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        let inventory = command_sandbox::discover_project_secrets(root)?;
        assert_eq!(inventory.len(), 5000);
        let invocation = invoke("true", root, &setup);
        let parent_setup = start.elapsed();
        let command_started = Instant::now();
        let output = Command::new(invocation.program)
            .args(invocation.arguments)
            .current_dir(root)
            .env("HOME", &setup.sandbox.home)
            .env("BUTLER_TEST_SANDBOX_TIMINGS", "1")
            .output()?;
        let total = command_started.elapsed();
        assert!(output.status.success(), "{output:?}");
        let timing = String::from_utf8(output.stderr).unwrap();
        let micros = timing
            .split_whitespace()
            .find_map(|field| field.strip_prefix("butler_sandbox_setup_us="))
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let kernel_setup = Duration::from_micros(micros);
        setup_times.push(parent_setup + kernel_setup);
        teardown_times.push(total.saturating_sub(kernel_setup));
        let moved = command_sandbox::sweep_new_secrets(root, &inventory, &setup.sandbox.data)?;
        assert_eq!(moved, Vec::<PathBuf>::new());
    }
    for index in 0..5000 {
        assert_eq!(
            std::fs::read_to_string(root.join(format!("node_modules/{index}.pem")))?,
            "protected"
        );
    }
    setup_times.sort();
    teardown_times.sort();
    eprintln!(
        "5k pem: setup p50={:.3} ms, teardown+exec p50={:.3} ms",
        setup_times[2].as_secs_f64() * 1000.0,
        teardown_times[2].as_secs_f64() * 1000.0
    );
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn project_lease_shutdown_cleans_active_and_waiting_commands() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux project lease shutdown"
    );
    use butler_turn::workspace::{Commands, GuidedAccess, GuidedCommandInput};
    use tokio_util::sync::CancellationToken;
    let mut setup = Setup::new("LINUX-PROJECT-LEASE-SHUTDOWN")?;
    let root = &setup.sandbox.workspace;
    std::fs::write(root.join(".gitignore"), "target\n")?;
    let ready = setup.sandbox.data.join("tmp/project-write/ready");
    let input = |command: String| GuidedCommandInput {
        command,
        cwd: None,
        workspace_root: root.clone(),
        butler_data: setup.sandbox.data.clone(),
        timeout_ms: Some(30_000.0),
        access: GuidedAccess::ProjectWrite,
        host_environment: HashMap::from([
            ("HOME".into(), setup.sandbox.home.display().to_string()),
            ("PATH".into(), std::env::var("PATH").unwrap()),
        ]),
        abort: CancellationToken::new(),
    };
    let owner = Commands::new();
    let first = owner
        .submit_guided(input(format!(
            "echo ready > '{}'; sleep 30",
            ready.display()
        )))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let second = owner
        .submit_guided(input("echo escaped > target/output".into()))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), owner.close())
        .await
        .unwrap();
    assert!(first.await.unwrap().is_err());
    assert!(second.await.unwrap().is_err());
    assert!(!root.join("target").exists());
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn hard_link_aliases_fail_closed_but_complete_public_groups_run() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux hard link boundary"
    );
    let mut setup = Setup::new("LINUX-HARD-LINK-BOUNDARY")?;
    std::fs::create_dir_all(setup.sandbox.data.join("tmp/project-write"))?;
    let root = &setup.sandbox.workspace;
    for secret in [".env", ".git/config"] {
        if let Some(parent) = root.join(secret).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(root.join(secret), "protected")?;
        std::fs::hard_link(root.join(secret), root.join("public"))?;
        let output = run(
            invoke("echo modified > public", root, &setup),
            root,
            &setup.sandbox.home,
        );
        assert_eq!(output.status.code(), Some(125), "{output:?}");
        assert_eq!(output.stdout, b"");
        assert!(String::from_utf8_lossy(&output.stderr).contains("project_write_link_aliases"));
        assert_eq!(std::fs::read_to_string(root.join(secret))?, "protected");
        std::fs::remove_file(root.join("public"))?;
    }
    let outside = setup.sandbox.home.join("outside");
    std::fs::write(&outside, "outside")?;
    std::fs::hard_link(&outside, root.join("public"))?;
    let output = run(
        invoke("echo modified > public", root, &setup),
        root,
        &setup.sandbox.home,
    );
    assert_eq!(output.status.code(), Some(125), "{output:?}");
    assert_eq!(std::fs::read_to_string(&outside)?, "outside");
    std::fs::remove_file(root.join("public"))?;
    std::fs::write(root.join("a"), "ordinary")?;
    std::fs::hard_link(root.join("a"), root.join("b"))?;
    let output = run(
        invoke("echo updated > a", root, &setup),
        root,
        &setup.sandbox.home,
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(std::fs::read_to_string(root.join("b"))?, "updated\n");
    setup.sandbox.mark_success();
    Ok(())
}
