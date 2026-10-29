use super::super::access_tiers::{self, stub};
use super::*;
use butler_e2e::e2e::{cassette::Cassette, scenario::Access};
use serde_json::json;
use std::time::{Duration, Instant};

#[tokio::test]
async fn row11_new_secrets_are_swept() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("WIN-11")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::write(
        project.join("build.cmd"),
        "@echo off\r\nmkdir sub\\.git\r\nmkdir deep\r\necho complete>made.txt\r\necho secret>sub\\.env\r\necho metadata>sub\\.git\\config\r\necho key>deep\\id_rsa\r\n",
    )?;
    let prompt = "Run the project step.";
    script.rounds.lock().unwrap().insert(prompt.into(),vec![stub::call("build","run_command",
        &json!({"command":"cmd /c build.cmd","summary":"Build project","state_effect":"mutation"}))]);
    if super::setup_only() {
        super::finish_setup(s).await?;
        server.abort();
        return Ok(());
    }
    let id = s.gw.say_turn(&chat, prompt).await?;
    access_tiers::delivered(&s, &chat, &id).await?;
    access_tiers::assert_counts(&s, &id, 0, 0)?;
    let text = access_tiers::outputs(&s, &chat, &id, &script, prompt)
        .await?
        .join("\n");
    assert!(text.contains("project_write_contained_swept"), "{text}");
    for name in ["sub/.env", "sub/.git", "deep/id_rsa"] {
        assert!(!project.join(name).exists(), "not swept: {name}");
    }
    assert_eq!(
        std::fs::read_to_string(project.join("made.txt"))?.trim(),
        "complete"
    );
    let quarantine = std::fs::read_dir(s.sandbox.data.join("sandbox-quarantine"))?
        .next()
        .unwrap()?
        .path();
    for (name, content) in [
        ("sub/.env", "secret"),
        ("sub/.git/config", "metadata"),
        ("deep/id_rsa", "key"),
    ] {
        assert_eq!(
            std::fs::read_to_string(quarantine.join(name))?.trim(),
            content
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn row12_timeout_and_agent_kill() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    for kill in [false, true] {
        interrupted(kill).await?;
    }
    Ok(())
}
async fn interrupted(kill: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("WIN-12")?
        .env("BUTLER_DEBUG_SANDBOX_TIMINGS", "1")
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    std::fs::write(
        project.join("wait.cmd"),
        "@echo off\r\npowershell -NoProfile -Command \"$PID | Set-Content -Encoding ASCII child.pid; Start-Sleep -Seconds 120\"\r\n",
    )?;
    let before = Command::new("subst.exe").output()?;
    let prompt = "Run the project step.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![stub::call(
            "wait",
            "run_command",
            &json!({"command":"cmd /c wait.cmd","summary":"Run project","state_effect":"mutation",
            "timeout_ms": if kill {30000} else {5000}}),
        )],
    );
    if super::setup_only() {
        super::finish_setup(s).await?;
        server.abort();
        return Ok(());
    }
    let id = s.gw.say_turn(&chat, prompt).await?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let pid = loop {
        if let Ok(text) = std::fs::read_to_string(project.join("child.pid"))
            && let Ok(pid) = text.trim().parse::<u32>()
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "contained child did not start: {}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    if kill {
        s.agent.kill9()?;
    } else {
        access_tiers::delivered(&s, &chat, &id).await?;
        let outputs = access_tiers::outputs(&s, &chat, &id, &script, prompt).await?;
        assert!(
            outputs
                .iter()
                .filter_map(|text| serde_json::from_str::<serde_json::Value>(text).ok())
                .any(|value| value
                    .get("output")
                    .filter(|v| v.is_object())
                    .unwrap_or(&value)["timed_out"]
                    == true),
            "timeout was not reported: {outputs:?}"
        );
        let text = outputs.join("\n");
        assert!(
            !text.contains(command_sandbox::EXECUTION_TIMEOUT_MARKER),
            "helper marker leaked"
        );
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while butler_platform::process_control::liveness(pid)
        != butler_platform::process_control::Liveness::Gone
    {
        assert!(Instant::now() < deadline, "contained child {pid} survived");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    command_sandbox::reconcile_project_write(&s.sandbox.data)?;
    for dir in ["sandbox/drives", "sandbox/policies", "tmp/project-write"] {
        let path = s.sandbox.data.join(dir);
        assert!(
            !path.exists() || std::fs::read_dir(path)?.count() == 0,
            "residue: {dir}"
        );
    }
    assert_eq!(before.stdout, Command::new("subst.exe").output()?.stdout);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn row16_non_interactive_asks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !command_sandbox::POSIX_SHELL && !desktop(),
        "Windows SSH/service required"
    );
    assert_eq!(
        command_sandbox::capabilities().project_write,
        command_sandbox::Level::Unavailable("non_interactive_desktop")
    );
    let f = Fixture::new("WIN-16-KILL-SWITCH")?;
    let helper = butler_e2e::e2e::binary::agent_binary()?.with_file_name("butler-sandbox.exe");
    let disabled = Command::new(helper)
        .arg("--probe")
        .envs(&f.env)
        .env("BUTLER_WINDOWS_PROJECT_SANDBOX", "0")
        .output()?;
    assert!(disabled.status.success(), "{disabled:?}");
    assert_eq!(
        String::from_utf8_lossy(&disabled.stdout).trim(),
        "mxc_disabled"
    );
    f.finish();
    super::super::windows_project_sandbox::approval_fallback().await
}

#[tokio::test]
async fn row12_timeout_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    interrupted(false).await
}
#[tokio::test]
async fn row12_agent_kill_cleanup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    interrupted(true).await
}
