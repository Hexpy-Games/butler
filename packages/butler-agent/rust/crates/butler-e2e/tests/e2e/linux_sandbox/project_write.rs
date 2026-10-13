//! Linux Auto must never silently execute an unavailable project-write policy.
use super::{HarnessError, HashMap, Setup, command_sandbox, json, stub};
use butler_e2e::e2e::{cassette::Cassette, scenario::Access};

#[tokio::test]
async fn unavailable_project_write_refuses_an_invocation() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    let mut setup = Setup::new("LINUX-PROJECT-WRITE-UNAVAILABLE")?;
    let project = &setup.sandbox.workspace;
    let scratch = setup.sandbox.data.join("tmp/project-write");
    let cache = setup.sandbox.data.join("cache/project-write");
    std::fs::create_dir_all(&scratch)?;
    std::fs::create_dir_all(&cache)?;
    assert!(!command_sandbox::project_write_available());
    let result = command_sandbox::project_write_shell(
        "echo unsafe > made.txt",
        &HashMap::from([("HOME".into(), setup.sandbox.home.display().to_string())]),
        project,
        &[&scratch, &cache],
        &[&setup.sandbox.data],
    );
    assert!(matches!(
        result,
        Err(command_sandbox::SandboxError::ProjectWriteUnavailable)
    ));
    assert!(!project.join("made.txt").exists());
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn auto_mutation_waits_for_approval_without_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("LINUX-AUTO-MUTATION-FALLBACK")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url);
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    let prompt = "Create the project output.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![stub::call(
            "make",
            "run_command",
            &json!({"command":"echo complete > made.txt", "summary":"Create output",
                "state_effect":"mutation"}),
        )],
    );
    let turn = super::super::access_tiers::paused(&s, &chat, prompt).await?;
    super::super::access_tiers::assert_counts(&s, &turn, 1, 1)?;
    assert!(!project.join("made.txt").exists(), "ran before approval");
    super::super::access_tiers::approve(&s, &chat, "deny").await?;
    super::super::access_tiers::delivered(&s, &chat, &turn).await?;
    super::super::access_tiers::assert_counts(&s, &turn, 1, 0)?;
    assert!(!project.join("made.txt").exists(), "ran after denial");
    eprintln!("Linux Auto fallback: authority_count=1 pending=0 writes=0");
    s.finish().await?;
    server.abort();
    Ok(())
}
