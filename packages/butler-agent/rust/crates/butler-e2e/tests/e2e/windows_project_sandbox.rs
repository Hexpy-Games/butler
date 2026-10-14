//! PR2 opt-in acceptance. Full interactive boundary coverage belongs to PR3.
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::{Access, Setup}};
use butler_platform::command_sandbox::{self, Level};
use serde_json::json;
use super::access_tiers::stub;

#[tokio::test]
async fn auto_mutation_waits_for_approval_without_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows approval fallback");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("WINDOWS-AUTO-MUTATION-FALLBACK")?
        .access(Access::Auto).stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url).env("BUTLER_WINDOWS_PROJECT_SANDBOX", "1");
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    let prompt = "Create the project output.";
    script.rounds.lock().unwrap().insert(prompt.into(), vec![stub::call(
        "make", "run_command", &json!({"command":"echo complete > made.txt",
            "summary":"Create output", "state_effect":"mutation"}),
    )]);
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
    let dirs = [data.join("tmp/project-write"), data.join("cache/project-write"), data.join("artifacts/generated")];
    for dir in &dirs { std::fs::create_dir_all(dir)?; }
    let system = env.iter().find(|(k,_)| k.eq_ignore_ascii_case("SYSTEMROOT")).ok_or("SYSTEMROOT missing")?.1;
    let subst = std::path::Path::new(system).join("System32/subst.exe");
    let before = std::process::Command::new(&subst).output()?;
    assert!(before.status.success());
    let invocation = command_sandbox::project_write_shell("cmd /c echo complete > made.txt", &env,
        &root, &dirs.iter().map(|p| p.as_path()).collect::<Vec<_>>(), &[])?;
    let mut cmd = std::process::Command::new(&invocation.program);
    command_sandbox::add_arguments(&mut cmd, &invocation);
    let output = cmd.current_dir(&root).output()?;
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(std::fs::read_to_string(root.join("made.txt"))?.trim(), "complete");
    command_sandbox::reconcile_project_write(data)?;
    assert_eq!(std::fs::read_dir(data.join("sandbox/drives"))?.count(), 0);
    let after = std::process::Command::new(&subst).output()?;
    assert_eq!(before.stdout, after.stdout);
    Ok(())
}
