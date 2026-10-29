//! Preparation and fallback regressions; the interactive matrix is in windows_sandbox.
use super::access_tiers::stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use butler_platform::command_sandbox::{self, Level};
use serde_json::json;

#[tokio::test]
async fn filesystem_preparation_normalizes_search_separators() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !command_sandbox::POSIX_SHELL,
        "Windows filesystem preparation"
    );
    let mut setup = Setup::new("WINDOWS-PATH-PREPARATION")?;
    let home = &setup.sandbox.home;
    let root = home.join("project");
    let tools = home.join("tools");
    let dirs = [
        setup.sandbox.data.join("tmp/project-write"),
        setup.sandbox.data.join("cache/project-write"),
        setup.sandbox.data.join("artifacts/generated"),
    ];
    for dir in [&root, &tools, &home.join("roaming"), &home.join("local")] {
        std::fs::create_dir_all(dir)?;
    }
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.retain(|key, _| {
        ![
            "CARGO_HOME",
            "RUSTUP_HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "BUTLER_DATA",
            "PATH",
        ]
        .iter()
        .any(|k| key.eq_ignore_ascii_case(k))
    });
    for (key, value) in [
        ("USERPROFILE", home.clone()),
        ("APPDATA", home.join("roaming")),
        ("LOCALAPPDATA", home.join("local")),
        ("BUTLER_DATA", setup.sandbox.data.clone()),
    ] {
        env.insert(key.into(), value.display().to_string());
    }
    env.insert("BUTLER_COMMAND_TIMEOUT_MS".into(), "30000".into());
    std::fs::write(
        tools.join("node.exe"),
        "untrusted executable must never run",
    )?;
    let repeated = format!(
        "{};{};{}\\\\tools",
        home.display(),
        root.parent().unwrap().display(),
        home.display()
    );
    env.insert("PATH".into(), repeated);
    let prepare = |env: &std::collections::HashMap<String, String>| {
        command_sandbox::windows_prepare_project_write(
            "cmd /c echo complete > made.txt",
            env,
            &root,
            &dirs
                .iter()
                .map(std::path::PathBuf::as_path)
                .collect::<Vec<_>>(),
            &[],
            super::windows_sandbox::toolchain_roots().as_ref(),
        )
    };
    let invocation = prepare(&env).map_err(|error| std::io::Error::other(error.to_string()))?;
    assert!(invocation.arguments.iter().any(|a| a == "--policy-file"));
    assert!(!root.join("made.txt").exists());
    prepared_scratch_is_scoped_and_released(&invocation, &setup.sandbox.data)?;
    let abandoned = prepare(&env).map_err(|e| std::io::Error::other(e.to_string()))?;
    let abandoned_path = std::path::PathBuf::from(&abandoned.arguments[1]);
    command_sandbox::reconcile_project_write(&setup.sandbox.data)?;
    assert!(abandoned_path.exists(), "live preparation was reclaimed");
    drop(abandoned);
    let orphan = setup.sandbox.data.join("tmp/project-write/before-policy");
    std::fs::create_dir(&orphan)?;
    let next = prepare(&env).map_err(|e| std::io::Error::other(e.to_string()))?;
    assert!(!abandoned_path.exists());
    assert!(!orphan.exists());
    command_sandbox::cleanup_prepared_invocation(&next)?;
    env.insert("PATH".into(), format!("{}.", tools.display()));
    let filtered = prepare(&env).map_err(|e| std::io::Error::other(e.to_string()))?;
    command_sandbox::cleanup_prepared_invocation(&filtered)?;
    env.insert("PATH".into(), tools.display().to_string());
    env.insert(
        "GH_CONFIG_DIR".into(),
        format!("{}\\credentials.", home.display()),
    );
    let error = prepare(&env).unwrap_err().to_string();
    assert!(
        error.contains("GH_CONFIG_DIR") && error.contains("trailing dot or space"),
        "{error}"
    );
    assert!(!error.contains(&home.display().to_string()));
    env.remove("GH_CONFIG_DIR");
    let outside = home.join("outside.txt");
    std::fs::write(&outside, "preserved")?;
    for dir in dirs.iter().skip(1) {
        let alias = dir.join("alias.txt");
        std::fs::hard_link(&outside, &alias)?;
        let error = prepare(&env).unwrap_err().to_string();
        assert!(error.contains("project_write_link_aliases"), "{error}");
        assert_eq!(std::fs::read_to_string(&outside)?, "preserved");
        std::fs::remove_file(alias)?;
    }
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn auto_mutation_waits_for_approval_without_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows approval fallback");
    approval_fallback().await
}

#[tokio::test]
async fn missing_helper_preserves_cli_startup_and_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows missing helper");
    for opt_in in ["", "1"] {
        approval_fallback_with_helper(true, Some(opt_in)).await?;
    }
    Ok(())
}

pub(super) async fn approval_fallback() -> Result<(), HarnessError> {
    approval_fallback_with_helper(false, None).await
}

async fn approval_fallback_with_helper(
    missing_helper: bool,
    opt_in: Option<&str>,
) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::mutates_installation("WINDOWS-AUTO-MUTATION-FALLBACK")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    if let Some(opt_in) = opt_in {
        setup = setup.env("BUTLER_WINDOWS_PROJECT_SANDBOX", opt_in);
    }
    if missing_helper {
        std::fs::remove_file(setup.sandbox.binary.with_file_name("butler-sandbox.exe"))?;
        let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
        for argument in ["--version", "--help"] {
            let output = launch.command().arg(argument).output()?;
            assert!(output.status.success(), "{output:?}");
        }
    }
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    let prompt = "Create the project output.";
    script
        .rounds
        .lock()
        .map_err(|_| std::io::Error::other("stub rounds lock poisoned"))?
        .insert(
            prompt.into(),
            vec![stub::call(
                "make",
                "run_command",
                &json!({"command":"echo complete > made.txt",
            "summary":"Create output", "state_effect":"mutation"}),
            )],
        );
    let turn = super::access_tiers::paused(&s, &chat, prompt).await?;
    super::access_tiers::assert_counts(&s, &turn, 1, 1)?;
    assert!(!project.join("made.txt").exists());
    super::access_tiers::approve(&s, &chat, "deny").await?;
    super::access_tiers::delivered(&s, &chat, &turn).await?;
    super::access_tiers::assert_counts(&s, &turn, 1, 0)?;
    assert!(!project.join("made.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn desktop_project_write_cleans_drive_journal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows desktop sandbox");
    butler_e2e::skip_unless!(
        std::env::var("BUTLER_E2E_WINDOWS_SANDBOX_DESKTOP").as_deref() == Ok("1"),
        "owner desktop harness required"
    );
    let mut setup = Setup::new("WINDOWS-PROJECT-WRITE")?;
    let root = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&root)?;
    let data = &setup.sandbox.data;
    let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
    env.insert("BUTLER_DATA".into(), data.display().to_string());
    env.insert("BUTLER_COMMAND_TIMEOUT_MS".into(), "30000".into());
    let dirs = [
        data.join("tmp/project-write"),
        data.join("cache/project-write"),
        data.join("artifacts/generated"),
    ];
    for dir in &dirs {
        std::fs::create_dir_all(dir)?;
    }
    let system = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("SYSTEMROOT"))
        .ok_or_else(|| std::io::Error::other("SYSTEMROOT missing"))?
        .1;
    let subst = std::path::Path::new(system).join("System32/subst.exe");
    let before = std::process::Command::new(&subst).output()?;
    assert!(before.status.success());
    let invocation = command_sandbox::windows_prepare_project_write(
        "cmd /c echo complete > made.txt",
        &env,
        &root,
        &dirs
            .iter()
            .map(std::path::PathBuf::as_path)
            .collect::<Vec<_>>(),
        &[],
        super::windows_sandbox::toolchain_roots().as_ref(),
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    // Admission is reproducible over SSH; process launch still requires WinSta0.
    let caps = command_sandbox::capabilities();
    assert!(matches!(caps.project_write, Level::Partial(_)), "{caps:?}");
    assert!(caps.network_deny.is_enforced());
    let mut cmd = std::process::Command::new(&invocation.program);
    command_sandbox::add_arguments(&mut cmd, &invocation);
    let output = cmd.current_dir(&root).output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("made.txt"))?.trim(),
        "complete"
    );
    command_sandbox::reconcile_project_write(data)?;
    assert_eq!(std::fs::read_dir(data.join("sandbox/drives"))?.count(), 0);
    let after = std::process::Command::new(&subst).output()?;
    assert_eq!(before.stdout, after.stdout);
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn probe_emits_loader_diagnostics() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows probe diagnostics");
    let mut setup = Setup::new("WINDOWS-PROBE-DIAGNOSTICS")?;
    let helper = setup.sandbox.binary.with_file_name("butler-sandbox.exe");
    let launch = butler_e2e::e2e::agent::Launch::new(&setup.sandbox)?;
    let diagnostic = setup.sandbox.home.join("probe.json");
    let out = launch
        .env_command(&helper)
        .args(["--probe", "--diagnostic"])
        .arg(&diagnostic)
        .env("BUTLER_WINDOWS_PROJECT_SANDBOX", "1")
        .output()?;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&std::fs::read(diagnostic)?)?;
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        report["reason"].as_str().unwrap()
    );
    assert_eq!(report["policy"]["ui"]["disable"], false);
    assert_eq!(report["policy"]["process"]["inheritDefaultEnv"], false);
    let paths = report["policy"]["filesystem"]["readonlyPaths"]
        .as_array()
        .unwrap();
    assert_eq!(paths.len(), 2);
    assert!(paths.iter().all(|v| v.as_str().unwrap().contains("<dir>")));
    assert!(report.get("stderr").is_some());
    assert!(report.get("mxcError").is_some());
    let reason = report["reason"].as_str().unwrap();
    assert_ne!(reason, "probe_failed");
    assert_ne!(reason, "probe_setup_failed", "{report}");

    if reason == "partial" || reason.starts_with("child_") {
        assert!(report["childExitCode"].is_i64() || report["reason"] == "child_timed_out");
        if report["childExitCode"].as_i64().is_some_and(|n| n < 0) {
            assert!(report["childNtstatus"].as_str().unwrap().starts_with("0xC"));
            assert_ne!(report["reason"], "non_interactive_desktop");
        }
    }
    setup.sandbox.mark_success();
    Ok(())
}

fn prepared_scratch_is_scoped_and_released(
    invocation: &command_sandbox::Invocation,
    data: &std::path::Path,
) -> Result<(), HarnessError> {
    let path = std::path::Path::new(&invocation.arguments[1]);
    let policy: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let scratch = std::path::Path::new(
        policy["scratch"]
            .as_str()
            .ok_or_else(|| std::io::Error::other("missing scratch"))?,
    );
    assert!(scratch.join("gitconfig").is_file());
    assert!(scratch.join("npmrc").is_file());
    let grants = policy["request"]["filesystem"]["readwritePaths"]
        .as_array()
        .ok_or_else(|| std::io::Error::other("missing grants"))?;
    let parent = physical_grant(&data.join("tmp/project-write"))?;
    let command_grant = physical_grant(scratch)?;
    assert_eq!(grants.len(), 4);
    assert!(!grants.iter().any(|grant| grant.as_str() == Some(&parent)));
    assert!(
        grants
            .iter()
            .any(|grant| grant.as_str() == Some(&command_grant))
    );
    command_sandbox::cleanup_prepared_invocation(invocation)?;
    assert!(!path.exists());
    assert!(!scratch.exists());
    reconciliation_continues_past_bad_entries(data, policy)?;
    Ok(())
}

fn reconciliation_continues_past_bad_entries(
    data: &std::path::Path,
    mut policy: serde_json::Value,
) -> Result<(), HarnessError> {
    let drives = data.join("sandbox/drives");
    std::fs::create_dir_all(drives.join("D.json"))?;
    std::fs::write(drives.join("E.json"), "torn claim")?;
    let policies = data.join("sandbox/policies");
    std::fs::create_dir_all(policies.join("bad.json"))?;
    let scratch = data.join("tmp/project-write/recovery");
    std::fs::create_dir(&scratch)?;
    policy["pid"] = json!(u32::MAX);
    policy["started"] = json!(0);
    policy["scratch"] = json!(scratch);
    std::fs::write(policies.join("stale.json"), serde_json::to_vec(&policy)?)?;
    command_sandbox::reconcile_project_write(data)?;
    assert!(!drives.join("E.json").exists());
    assert!(!policies.join("stale.json").exists());
    assert!(!scratch.exists());
    std::fs::remove_dir(drives.join("D.json"))?;
    std::fs::remove_dir(policies.join("bad.json"))?;
    Ok(())
}

fn physical_grant(path: &std::path::Path) -> std::io::Result<String> {
    let canonical = butler_platform::secure_fs::canonicalize(path)?;
    command_sandbox::mxc_policy::WinPath::new(&canonical.to_string_lossy())
        .map(|path| path.as_str().to_owned())
        .map_err(std::io::Error::other)
}
