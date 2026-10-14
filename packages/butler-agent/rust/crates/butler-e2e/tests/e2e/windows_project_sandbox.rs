//! PR2 opt-in acceptance. Full interactive boundary coverage belongs to PR3.
use super::access_tiers::stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use butler_platform::command_sandbox::{self, Level};
use serde_json::json;

#[tokio::test]
async fn auto_mutation_waits_for_approval_without_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows approval fallback");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("WINDOWS-AUTO-MUTATION-FALLBACK")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .env("BUTLER_WINDOWS_PROJECT_SANDBOX", "1");
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    let prompt = "Create the project output.";
    script.rounds.lock().unwrap().insert(
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
    let caps = command_sandbox::capabilities();
    assert!(matches!(caps.project_write, Level::Partial(_)), "{caps:?}");
    assert!(caps.network_deny.is_enforced());
    let setup = Setup::new("WINDOWS-PROJECT-WRITE")?;
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
    let invocation = command_sandbox::project_write_shell(
        "cmd /c echo complete > made.txt",
        &env,
        &root,
        &dirs
            .iter()
            .map(std::path::PathBuf::as_path)
            .collect::<Vec<_>>(),
        &[],
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;
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
    Ok(())
}

#[tokio::test]
async fn probe_emits_loader_diagnostics() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows probe diagnostics");
    let mut setup = Setup::new("WINDOWS-PROBE-DIAGNOSTICS")?;
    let agent = butler_e2e::e2e::binary::agent_binary()?;
    let helper = agent.with_file_name("butler-sandbox.exe");
    let diagnostic = setup.sandbox.home.join("probe.json");
    let out = std::process::Command::new(helper)
        .args(["--probe", "--diagnostic"])
        .arg(&diagnostic)
        .env("BUTLER_WINDOWS_PROJECT_SANDBOX", "1")
        .env("HOME", &setup.sandbox.home)
        .env("BUTLER_DATA", &setup.sandbox.data)
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
    assert_ne!(reason, "non_interactive_desktop");
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
