//! The boundary is the same in every access mode, and for every way a turn starts.
use super::*;

/// Runs a turn to its end, giving `action` to every card it stops on.
async fn through_cards(
    s: &Scenario,
    chat: &str,
    turn: &str,
    action: &str,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let current =
            s.gw.wait_turn(
                chat,
                turn,
                &["waiting_for_form", "delivered", "failed", "cancelled"],
                Duration::from_secs(30),
            )
            .await?;
        if current["state"] != "waiting_for_form" {
            return Ok(current);
        }
        for asked in s.gw.approval_requests(chat).await? {
            answer(s, chat, &asked, action).await?;
        }
        assert!(Instant::now() < deadline, "{current}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn in_mode(name: &str, mode: &str) -> Result<(), HarnessError> {
    let setup = Setup::new(name)?.stub_cassette(Cassette::load("TOOL-01")?);
    let (s, project) = start_with(setup).await?;
    s.patch_settings(json!({"access_mode":mode}), "mode")
        .await?;
    let chat = project.new_chat(&s).await?;
    project.write(&[project.observer("guard", "Stop", "ran.jsonl")])?;
    // Nothing runs before the answer, whatever the mode.
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["action_kind"], "project_hooks");
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    // Denying the tool cards that follow keeps this turn from changing anything.
    let done = through_cards(&s, &chat, &turn, "deny").await?;
    assert_eq!(done["state"], "delivered", "{done}");
    assert_eq!(project.ran("ran.jsonl").len(), 0);

    // Neither tool writes the user's answers, even if every file card is allowed.
    let store = s.sandbox.data.join("auth/project-hook-trust.json");
    let bytes = fs::read(&store)?;
    s.provider()?.set_chat_responder(stub::forge_trust);
    let prompt = format!("Write {{}} to <path>{}</path>", store.display());
    let turn = s.gw.say_turn(&chat, &prompt).await?;
    through_cards(&s, &chat, &turn, "allow").await?;
    assert_eq!(
        fs::read(&store)?,
        bytes,
        "{mode}: a file tool wrote the answers"
    );
    s.provider()?
        .set_chat_responder(stub::forge_trust_by_command);
    let turn = s.gw.say_turn(&chat, &prompt).await?;
    through_cards(&s, &chat, &turn, "deny").await?;
    assert_eq!(
        fs::read(&store)?,
        bytes,
        "{mode}: a command wrote the answers"
    );
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_boundary_holds_in_auto() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    in_mode("HOOK-PROJECT-MODE-AUTO", "auto").await
}

#[tokio::test]
async fn project_hooks_boundary_holds_in_ask_first() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    in_mode("HOOK-PROJECT-MODE-ASK", "ask_first").await
}

#[tokio::test]
async fn project_hooks_boundary_holds_in_read_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    in_mode("HOOK-PROJECT-MODE-READ", "read_only").await
}

#[tokio::test]
async fn project_hooks_run_now_is_attended_and_asks() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-RUN-NOW").await?;
    let chat = project.chat.clone();
    // Ask-first runs it in the sandbox, so it can only write inside the project.
    let out = project.root.join("ran.jsonl");
    let mut guard = project.observer("guard", "Stop", "ran.jsonl");
    guard["env"]["HOOK_OUTPUT"] = json!(out);
    project.write(&[guard])?;
    let created =
        s.gw.post(
            "/automations",
            json!({"title":"Now","prompt_body":"Check evidence.","target_session_id":chat,
        "schedule_type":"once","run_at":"2099-01-01T00:00:00.000Z","access_mode":"ask_first"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let id = created.data()["automation"]["id"].as_str().unwrap();
    let started =
        s.gw.post(&format!("/automations/{id}/run"), json!({}))
            .await?;
    assert!(started.status < 300, "{}", started.text);
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["action_kind"], "project_hooks");
    assert!(!out.exists());
    answer(&s, &chat, &asked, "allow").await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !out.exists() {
        // The run's own reads wait for ask-first cards; none of them are about hooks.
        for pending in s.gw.approval_requests(&chat).await? {
            assert_ne!(
                pending["approval"]["action_kind"], "project_hooks",
                "{pending}"
            );
            answer(&s, &chat, &pending, "allow").await?;
        }
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    s.finish().await
}

#[tokio::test]
async fn project_hooks_reach_a_child_after_the_parent_is_answered() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, _script, server) = child_stub::start(false).await?;
    let setup = Setup::new("HOOK-PROJECT-CHILD")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let observe = fixture(&setup, "observe");
    let mut s = setup.start().await?;
    let parent = s.sandbox.root.join("projects");
    fs::create_dir_all(&parent)?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    let root = parent.join("작업 Project");
    fs::create_dir_all(root.join(".butler"))?;
    let out = s.sandbox.home.join("child.jsonl");
    let hooks = json!({"version":1,"hooks":[{"id":"child","event":"SubagentStop","type":"command","args":observe,
        "env":{"HOOK_OUTPUT":out},"timeout_ms":3000}]});
    fs::write(root.join(".butler/hooks.json"), hooks.to_string())?;
    let turn = s.gw.say_turn(&chat, child_stub::OWNER).await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while !out.exists() {
        assert!(
            Instant::now() < deadline,
            "{:?}\n{}",
            s.gw.turn(&chat, &turn).await?,
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let run = &payloads_at(&out)[0];
    assert_eq!(run["hook_event_name"], "SubagentStop");
    assert_eq!(run["hook"]["scope"], "project");
    assert_ne!(run["session_id"], run["parent_session_id"]);
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    s.finish().await?;
    server.abort();
    Ok(())
}
