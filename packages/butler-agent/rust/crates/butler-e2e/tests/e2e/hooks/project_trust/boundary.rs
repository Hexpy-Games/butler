//! The trust boundary: swaps, replaced folders, model edits, nobody to answer, and
//! the forms a project file may not take.
use super::*;

#[tokio::test]
async fn project_hooks_swap_before_the_answer_runs_only_what_was_approved()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-SWAP").await?;
    let chat = project.chat.clone();
    project.write(&[project.observer("guard", "PreToolUse", "shown.jsonl")])?;
    let turn = s.gw.say_turn(&chat, "Check.").await?;
    let shown = card(&s, &chat).await?;
    assert!(
        lines(&shown)[0]["command"]
            .as_str()
            .unwrap()
            .contains("shown.jsonl")
    );

    // Swapped after the card went up: allowing it must not run the new content.
    project.write(&[project.observer("guard", "PreToolUse", "swapped.jsonl")])?;
    answer(&s, &chat, &shown, "allow").await?;
    let again = {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let next = card(&s, &chat).await?;
            if next["request_ref"] != shown["request_ref"] {
                break next;
            }
            assert!(Instant::now() < deadline, "{}", s.agent.logs());
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    let line = &lines(&again)[0];
    assert!(line["command"].as_str().unwrap().contains("swapped.jsonl"));
    assert_eq!(line["change"], "changed");
    assert_eq!(project.ran("shown.jsonl").len(), 0);
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    answer(&s, &chat, &again, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("swapped.jsonl").len(), 1);
    assert_eq!(project.ran("shown.jsonl").len(), 0);

    s.finish().await
}

#[tokio::test]
async fn project_hooks_a_swap_mid_turn_does_not_reach_the_running_turn() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-MIDTURN").await?;
    let chat = project.chat.clone();
    let approved = [
        project.observer("post", "PostToolUse", "post.jsonl"),
        project.observer("stop", "Stop", "stop.jsonl"),
    ];
    project.write(&approved)?;
    let turn = s.gw.say_turn(&chat, "Allow first.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;

    // The turn is between its tool and its answer when the file is swapped.
    let gate = s.provider()?.hold_after_tool("In the middle.");
    let turn = s.gw.say_turn(&chat, "In the middle.").await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    while project.ran("post.jsonl").len() < 2 {
        assert!(Instant::now() < deadline, "{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    project.write(&[project.observer("stop", "Stop", "swapped.jsonl")])?;
    gate.release();
    delivered(&s, &chat, &turn).await?;
    assert_eq!(
        project.ran("stop.jsonl").len(),
        2,
        "the running turn kept what it read"
    );
    assert_eq!(project.ran("swapped.jsonl").len(), 0);

    // The next turn asks about what is there now.
    let turn = s.gw.say_turn(&chat, "Next.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["project_hooks"]["changed"], true);
    answer(&s, &chat, &asked, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("swapped.jsonl").len(), 0);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_answer_covers_one_folder_not_its_path() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-FOLDER").await?;
    let chat = project.chat.clone();
    let hooks = [project.observer("guard", "PreToolUse", "ran.jsonl")];
    project.write(&hooks)?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 1);

    // Another folder at the same path, holding the same file, was never answered for.
    let aside = project.root.with_file_name("aside");
    fs::rename(&project.root, &aside)?;
    fs::create_dir_all(&project.root)?;
    fs::write(project.root.join("hook-input.txt"), "Other folder")?;
    project.write(&hooks)?;
    let turn = s.gw.say_turn(&chat, "Replaced.").await?;
    let asked = card(&s, &chat).await?;
    assert_eq!(asked["approval"]["project_hooks"]["changed"], false);
    assert_eq!(project.ran("ran.jsonl").len(), 1);
    answer(&s, &chat, &asked, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 1);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_model_edit_asks_again_and_cannot_forge_trust() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-MODEL").await?;
    let chat = project.chat.clone();
    project.write(&[project.observer("guard", "PostToolUse", "ran.jsonl")])?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    let before = project.ran("ran.jsonl").len();

    // A real model tool rewrites the file: this turn keeps what it read.
    s.provider()?.set_chat_responder(stub::edit_project_hooks);
    let turn = s.gw.say_turn(&chat, "Rewrite the hooks.").await?;
    delivered(&s, &chat, &turn).await?;
    let written = fs::read_to_string(project.root.join(".butler/hooks.json"))?;
    assert!(
        written.contains("model-hook-ran"),
        "{written}\n{}",
        s.agent.logs()
    );
    assert_eq!(project.ran("ran.jsonl").len(), before + 1);
    assert!(!project.root.join("model-hook-ran").exists());

    // The next turn asks, and shows exactly what the model wrote.
    s.provider()?.set_chat_responder(stub::read_input);
    let turn = s.gw.say_turn(&chat, "Next.").await?;
    let asked = card(&s, &chat).await?;
    let shown = lines(&asked);
    let written = shown.iter().find(|line| line["id"] == "written").unwrap();
    assert_eq!(written["change"], "added");
    assert!(
        written["command"]
            .as_str()
            .unwrap()
            .contains("model-hook-ran")
    );
    assert!(!project.root.join("model-hook-ran").exists());
    answer(&s, &chat, &asked, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    assert!(!project.root.join("model-hook-ran").exists());

    // No file tool reaches the record of the user's answers, whatever the mode.
    let store = s.sandbox.data.join("auth/project-hook-trust.json");
    let bytes = fs::read(&store)?;
    s.provider()?.set_chat_responder(stub::forge_trust);
    let prompt = format!("Write {{}} to <path>{}</path>", store.display());
    let turn = s.gw.say_turn(&chat, &prompt).await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(fs::read(&store)?, bytes, "a model tool changed the answers");
    let rows = tool_rows(&s.gw.messages(&chat).await?, &turn);
    let row = rows
        .iter()
        .find(|r| r["tool_call_id"] == "call_hooks")
        .unwrap();
    assert_eq!(row["state"], "failed", "{rows:?}");
    s.finish().await
}

#[tokio::test]
async fn project_hooks_stopping_a_turn_at_the_card_answers_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-STOP").await?;
    let chat = project.chat.clone();
    project.write(&[project.observer("guard", "PreToolUse", "ran.jsonl")])?;
    let turn = s.gw.say_turn(&chat, "First.").await?;
    let asked = card(&s, &chat).await?;
    let stopped =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert!(stopped.status < 300, "{}", stopped.text);
    let done =
        s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
            .await?;
    assert_eq!(done["state"], "cancelled", "{done}");
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    // Nobody answered, so the next turn asks again.
    let turn = s.gw.say_turn(&chat, "Next.").await?;
    let again = card(&s, &chat).await?;
    assert_ne!(again["request_ref"], asked["request_ref"]);
    answer(&s, &chat, &again, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    s.finish().await
}

/// One due schedule on the chat, until its run finished.
pub(super) async fn scheduled_run(
    s: &Scenario,
    chat: &str,
    title: &str,
) -> Result<(), HarnessError> {
    scheduled_run_in(s, chat, title, "full_access").await
}

pub(super) async fn scheduled_run_in(
    s: &Scenario,
    chat: &str,
    title: &str,
    mode: &str,
) -> Result<(), HarnessError> {
    let created =
        s.gw.post(
            "/automations",
            json!({"title":title,"prompt_body":"Check evidence.","target_session_id":chat,
        "schedule_type":"once","run_at":"2000-01-01T00:00:00.000Z","access_mode":mode}),
        )
        .await?;
    assert_eq!(created.status, 201, "{created:?}");
    let id = created.data()["automation"]["id"].as_str().unwrap();
    assert_eq!(
        s.gw.post("/automations/dispatch-due", json!({}))
            .await?
            .status,
        202
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let reply = s.gw.get(&format!("/automations/{id}/runs")).await?;
        if let Some(run) = reply.data()["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|run| run["state"] == "succeeded")
        {
            return delivered(s, chat, run["turn_id"].as_str().unwrap()).await;
        }
        assert!(Instant::now() < deadline, "{reply:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::test]
async fn project_hooks_scheduled_run_with_no_approver_runs_none() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-SCHEDULE").await?;
    let chat = project.chat.clone();
    project.write(&[project.observer("stop", "Stop", "ran.jsonl")])?;
    let rounds = s.provider()?.requests().len();
    scheduled_run(&s, &chat, "Unanswered").await?;
    // The turn went on, nobody was asked, and the hook did not run.
    assert!(s.provider()?.requests().len() > rounds);
    assert_eq!(s.gw.approval_requests(&chat).await?, Vec::<Value>::new());
    assert_eq!(project.ran("ran.jsonl").len(), 0);

    // Someone at the screen is asked as usual; after that the schedule runs it too.
    let turn = s.gw.say_turn(&chat, "I am here.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    delivered(&s, &chat, &turn).await?;
    assert_eq!(project.ran("ran.jsonl").len(), 1);
    scheduled_run(&s, &chat, "Answered").await?;
    assert_eq!(project.ran("ran.jsonl").len(), 2);
    s.finish().await
}

#[tokio::test]
async fn project_hooks_refused_forms_run_nothing_and_ask_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, project) = start("HOOK-PROJECT-REFUSED").await?;
    let chat = project.chat.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/hook", listener.local_addr()?);
    project.write(&[
        json!({"id":"web","event":"Stop","type":"http","url":url,"timeout_ms":1000}),
        project.observer("guard", "Stop", "ran.jsonl"),
    ])?;
    quiet_turn(&s, &chat, "HTTP hook.").await?;
    assert_eq!(project.ran("ran.jsonl").len(), 0);
    let accept = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
    assert!(accept.is_err(), "a project HTTP hook reached its receiver");
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(
        runs.text.contains("project:.butler/hooks.json"),
        "{}",
        runs.text
    );

    // A parser quotes what it read: bounded and spelled out before anyone sees it.
    let bait = format!("bogus\u{1b}[2J{}", "x".repeat(2000));
    fs::write(
        project.root.join(".butler/hooks.json"),
        json!({"version":1,"hooks":[],(bait):1}).to_string(),
    )?;
    quiet_turn(&s, &chat, "Broken file.").await?;
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    let reason = runs
        .data()
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find_map(|run| {
            (run["hook_id"] == "project:.butler/hooks.json").then(|| run["reason"].clone())
        });
    let reason = reason.unwrap();
    let reason = reason.as_str().unwrap();
    assert!(reason.contains("bogus\\u{1b}[2J"), "{reason}");
    assert!(reason.len() < 700, "{}", reason.len());

    // Nothing reached through a link counts as the project's own file.
    if command_sandbox::POSIX_SHELL {
        let outside = s.sandbox.root.join("outside-hooks.json");
        fs::write(
            &outside,
            json!({"version":1,"hooks":[project.observer("guard", "Stop", "ran.jsonl")]})
                .to_string(),
        )?;
        fs::remove_file(project.root.join(".butler/hooks.json"))?;
        butler_platform::secure_fs::symlink(&outside, &project.root.join(".butler/hooks.json"))?;
        quiet_turn(&s, &chat, "File link.").await?;
        fs::remove_file(project.root.join(".butler/hooks.json"))?;
        fs::remove_dir(project.root.join(".butler"))?;
        let elsewhere = s.sandbox.root.join("elsewhere");
        fs::create_dir_all(&elsewhere)?;
        fs::copy(&outside, elsewhere.join("hooks.json"))?;
        butler_platform::secure_fs::symlink(&elsewhere, &project.root.join(".butler"))?;
        quiet_turn(&s, &chat, "Folder link.").await?;
        assert_eq!(project.ran("ran.jsonl").len(), 0);
    }
    s.finish().await
}

#[tokio::test]
async fn project_hooks_cannot_approve_actions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("HOOK-PROJECT-ALLOW")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .access(Access::AskAlways);
    let (s, project) = start_with(setup).await?;
    let chat = project.chat.clone();
    let allow = if command_sandbox::POSIX_SHELL {
        "echo '{\"decision\":\"allow\"}'"
    } else {
        "echo {\"decision\":\"allow\"}"
    };
    let mut hook = hook("approve", "PreToolUse", allow);
    hook["match"] = json!({"tools":["run_command"]});
    project.write(&[hook])?;
    s.provider()?.set_chat_responder(stub::command);
    let turn = s.gw.say_turn(&chat, "Run the hook test command.").await?;
    answer(&s, &chat, &card(&s, &chat).await?, "allow").await?;
    // The hook said allow, and the command still waits for its own card.
    let command = card(&s, &chat).await?;
    assert_eq!(
        command["approval"]["action_kind"], "run_command",
        "{command}"
    );
    assert!(!s.sandbox.home.join("tool-ran").exists());
    answer(&s, &chat, &command, "deny").await?;
    delivered(&s, &chat, &turn).await?;
    assert!(!s.sandbox.home.join("tool-ran").exists());
    let runs = api(&s, Method::GET, "/hooks/runs", None).await?;
    assert!(runs.text.contains("approval_ignored"), "{}", runs.text);
    s.finish().await
}
