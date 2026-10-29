//! The public setting gates both command admission and project inventory work.
use super::super::access_tiers::{self, stub};
use super::*;
use butler_e2e::e2e::{
    cassette::Cassette,
    scenario::{Access, Scenario},
};
use serde_json::json;

#[tokio::test]
async fn row17_command_sandbox_setting() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    for kill_switch in [false, true] {
        setting_roundtrip(kill_switch).await?;
    }
    Ok(())
}

async fn setting_roundtrip(kill_switch: bool) -> Result<(), HarnessError> {
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("WIN-17")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_DEBUG_SANDBOX_TIMINGS", "1");
    if kill_switch {
        setup = setup.env("BUTLER_WINDOWS_PROJECT_SANDBOX", "0");
    }
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir(&folder)?;
    let mut s = setup.start().await?;
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], true);
    set_enabled(&s, false).await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    for prompt in ["Run with sandbox off.", "Run with sandbox on."] {
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![stub::call(
                "write",
                "run_command",
                &json!({
                    "command":"cmd /c echo complete > made.txt", "summary":"Write project output",
                    "state_effect":"mutation"
                }),
            )],
        );
    }
    if super::setup_only() {
        super::finish_setup(s).await?;
        server.abort();
        return Ok(());
    }
    asks_without_preparation(&s, &chat, &project, "Run with sandbox off.").await?;
    set_enabled(&s, true).await?;
    assert_eq!(
        s.gw.settings().await?["command_sandbox_available"],
        !kill_switch
    );
    if kill_switch {
        asks_without_preparation(&s, &chat, &project, "Run with sandbox on.").await?;
    } else {
        let prompt = "Run with sandbox on.";
        let id = s.gw.say_turn(&chat, prompt).await?;
        access_tiers::delivered(&s, &chat, &id).await?;
        access_tiers::assert_counts(&s, &id, 0, 0)?;
        let output = access_tiers::outputs(&s, &chat, &id, &script, prompt)
            .await?
            .join("\n");
        assert!(output.contains("project_write_contained"), "{output}");
        assert_eq!(
            std::fs::read_to_string(project.join("made.txt"))?.trim(),
            "complete"
        );
    }
    eprintln!(
        "WIN-17 off=asked prepared=false on_contained={} kill_switch={kill_switch}",
        !kill_switch
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn set_enabled(s: &Scenario, enabled: bool) -> Result<(), HarnessError> {
    let reply =
        s.gw.patch("/settings", json!({"command_sandbox_enabled":enabled}))
            .await?;
    assert_eq!(reply.status, 200);
    assert_eq!(s.gw.settings().await?["command_sandbox_enabled"], enabled);
    Ok(())
}

async fn asks_without_preparation(
    s: &Scenario,
    chat: &str,
    project: &Path,
    prompt: &str,
) -> Result<(), HarnessError> {
    let id = access_tiers::paused(s, chat, prompt).await?;
    access_tiers::assert_counts(s, &id, 1, 1)?;
    assert!(!project.join("made.txt").exists());
    access_tiers::approve(s, chat, "deny").await?;
    access_tiers::delivered(s, chat, &id).await?;
    access_tiers::assert_counts(s, &id, 1, 0)?;
    assert!(!project.join("made.txt").exists());
    // Preparation must not even start: cleanup of a briefly created container
    // or background inventory would not satisfy the disabled-setting contract.
    for directory in ["sandbox/policies", "sandbox/drives", "tmp/project-write"] {
        assert!(
            !s.sandbox.data.join(directory).exists(),
            "prepared {directory}"
        );
    }
    let logs = s.agent.logs();
    for phase in [
        "ledger_build",
        "ledger_verify",
        "prepare",
        "container_create",
    ] {
        assert!(
            !logs.contains(&format!("phase={phase} ")),
            "disabled work: {phase}"
        );
    }
    Ok(())
}
