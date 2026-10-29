//! Linux Auto keeps asking when the required kernel boundaries are unavailable.
use super::{HarnessError, Setup, command_sandbox, json, stub, test_support_agent};
use butler_e2e::e2e::{cassette::Cassette, scenario::Access};

#[tokio::test]
async fn auto_mutation_waits_for_approval_without_running() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox scenario");
    let (url, script, server) = stub::start().await?;
    let setup = test_support_agent(Setup::mutates_installation("LINUX-AUTO-MUTATION-FALLBACK")?)?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_TEST_LANDLOCK_ABI", "5");
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

#[tokio::test]
async fn auto_project_writes_sweep_and_retry_asks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux project sandbox");
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("LINUX-AUTO-L1")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let folder = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&folder)?;
    let mut s = setup.start().await?;
    let chat = super::super::project_workspace::bind_project(&mut s, &folder).await?;
    let project = folder.join("작업 Project");
    for dir in ["src", "sub"] {
        std::fs::create_dir_all(project.join(dir))?;
    }
    // Script contents are deliberately invisible to lexical admission: the
    // kernel and post-run sweep must independently contain the operation.
    std::fs::write(
        project.join("build.sh"),
        "echo complete > src/output\nmkdir sub/.git\necho planted > sub/.git/config\necho new > sub/.env\n",
    )?;
    let prompt = "Run the project step.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![stub::call(
            "build",
            "run_command",
            &json!({"command":"sh build.sh", "summary":"Build project", "state_effect":"mutation"}),
        )],
    );
    let id = butler_e2e::e2e::scenario::accepted_turn_id(&s.gw.say(&chat, prompt).await?)?;
    super::super::access_tiers::delivered(&s, &chat, &id).await?;
    super::super::access_tiers::assert_counts(&s, &id, 0, 0)?;
    let outputs = super::super::access_tiers::outputs(&s, &chat, &id, &script, prompt).await?;
    let text = outputs.join("\n");
    assert!(text.contains("project_write_contained_swept"), "{text}");
    assert!(
        text.contains("sandbox_violation")
            && text.contains("sub/.git")
            && text.contains("sub/.env"),
        "{text}"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("src/output"))?,
        "complete\n"
    );
    assert!(!project.join("sub/.git").exists());
    assert!(!project.join("sub/.env").exists());
    let quarantine = std::fs::read_dir(s.sandbox.data.join("sandbox-quarantine"))?
        .next()
        .unwrap()?
        .path();
    assert_eq!(
        std::fs::read_to_string(quarantine.join("sub/.git/config"))?,
        "planted\n"
    );

    let prompt = "Create a top-level output.";
    let command = "echo top > top-output";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![stub::call(
            "top",
            "run_command",
            &json!({"command":command, "summary":"Create output", "state_effect":"mutation"}),
        )],
    );
    let id = butler_e2e::e2e::scenario::accepted_turn_id(&s.gw.say(&chat, prompt).await?)?;
    super::super::access_tiers::delivered(&s, &chat, &id).await?;
    super::super::access_tiers::assert_counts(&s, &id, 0, 0)?;
    let outputs = super::super::access_tiers::outputs(&s, &chat, &id, &script, prompt).await?;
    let text = outputs.join("\n");
    assert!(text.contains("project_write_contained"), "{text}");
    let mounted = command_sandbox::capabilities().project_write.is_enforced();
    if mounted {
        assert_eq!(
            std::fs::read_to_string(project.join("top-output"))?,
            "top\n"
        );
        assert!(!text.contains("the user will be asked"), "{text}");
    } else {
        assert!(
            text.contains("top-level project entries") && text.contains("the user will be asked"),
            "{text}"
        );
        assert!(!project.join("top-output").exists());
    }
    let prompt = "Retry with requested access.";
    script.rounds.lock().unwrap().insert(prompt.into(), vec![stub::call(
        "retry", "run_command", &json!({"command":command, "summary":"Create output", "state_effect":"mutation", "sandbox":"none"}),
    )]);
    let id = super::super::access_tiers::paused(&s, &chat, prompt).await?;
    super::super::access_tiers::assert_counts(&s, &id, 1, 1)?;
    let cards = s.gw.approval_requests(&chat).await?;
    assert!(
        cards[0].to_string().contains(command),
        "approval must show exact action"
    );
    super::super::access_tiers::approve(&s, &chat, "deny").await?;
    super::super::access_tiers::delivered(&s, &chat, &id).await?;
    if mounted {
        assert_eq!(
            std::fs::read_to_string(project.join("top-output"))?,
            "top\n"
        );
    } else {
        assert!(!project.join("top-output").exists());
    }
    eprintln!("Linux Auto: src write=complete approvals=0 secrets=quarantined retry=asked");
    s.finish().await?;
    server.abort();
    Ok(())
}
