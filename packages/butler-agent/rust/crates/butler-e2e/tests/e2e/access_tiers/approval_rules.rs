use super::auto::unattended::run_where;
use super::stub::{self, call};
use super::{approve, assert_counts, delivered, outputs, paused, read};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Setup},
};
use butler_platform::command_sandbox::WINDOWS_SHELL;
use serde_json::json;

const NEW_FILE_COMMAND: &str = if WINDOWS_SHELL { "New-Item" } else { "touch" };

#[tokio::test]
async fn prefix_rule_from_card_covers_later_commands() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-PREFIX")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let parent = setup.sandbox.home.join("project");
    std::fs::create_dir_all(&parent)?;
    let mut scenario = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut scenario, &parent).await?;
    let project = parent.join("작업 Project");
    let navigation = scenario.gw.get("/navigation").await?;
    let project_id = navigation.data()["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|project| {
            project["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|session| session["id"] == chat)
        })
        .unwrap()["id"]
        .clone();
    assert!(
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()?
            .success()
    );
    for name in ["a", "b", "c", "d", "e"] {
        std::fs::write(project.join(format!("{name}.txt")), name)?;
        script.rounds.lock().unwrap().insert(
            format!("Stage file {name}."),
            vec![call(
                name,
                "run_command",
                &json!({"command":format!("git add {name}.txt"),
            "state_effect":"mutation","summary":"Stage file"}),
            )],
        );
    }
    let first_turn = paused(&scenario, &chat, "Stage file a.").await?;
    let cards = scenario.gw.approval_requests(&chat).await?;
    assert_eq!(
        cards[0]["approval"]["operation"]["rule_prefixes"],
        json!(["git add"])
    );
    approve(&scenario, &chat, "allow", Some("conversation")).await?;
    delivered(&scenario, &chat, &first_turn).await?;
    let conversation_turn = scenario.gw.say_turn(&chat, "Stage file b.").await?;
    delivered(&scenario, &chat, &conversation_turn).await?;
    assert_counts(&scenario, &conversation_turn, 0, 0)?;
    assert!(project.join(".git/index").is_file());

    let mut chats = Vec::new();
    for title in ["Second chat", "Third chat"] {
        let reply = scenario
            .gw
            .post(
                "/sessions",
                json!({"kind":"project","project_id":project_id,
            "workspace_mode":"local","title":title}),
            )
            .await?;
        assert_eq!(reply.status, 201, "{}", reply.text);
        chats.push(reply.data()["session"]["id"].as_str().unwrap().to_owned());
    }
    let approval_turn = paused(&scenario, &chats[0], "Stage file c.").await?;
    approve(&scenario, &chats[0], "allow", Some("always")).await?;
    delivered(&scenario, &chats[0], &approval_turn).await?;
    let always_turn = scenario.gw.say_turn(&chats[1], "Stage file d.").await?;
    delivered(&scenario, &chats[1], &always_turn).await?;
    assert_counts(&scenario, &always_turn, 0, 0)?;
    let listed = scenario.gw.get("/authority-permissions").await?;
    let listed = listed.data();
    let saved = listed["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["target"] == "git add" && row["scope"] == "always")
        .unwrap();
    let revoked = scenario
        .gw
        .post(
            "/authority-permissions/revoke",
            json!({"grants":[{"grant_ref":saved["grant_ref"],"session_id":saved["session_id"]}]}),
        )
        .await?;
    assert_eq!(revoked.status, 200, "{}", revoked.text);
    paused(&scenario, &chats[1], "Stage file e.").await?;
    scenario.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn prefix_rules_apply_through_cmd_wrapper() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if !WINDOWS_SHELL {
        return Ok(());
    }
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-CMD-PREFIX")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let mut s = setup.start().await?;
    let project = s.sandbox.workspace.join("작업 Project");
    let chat = crate::project_workspace::bind_project(&mut s, project.parent().unwrap()).await?;
    let mut git = std::process::Command::new("git");
    git.args(["init", "-q"]).current_dir(&project);
    assert!(git.status()?.success());
    let quote = "cmd /c git add ' & del b.txt & echo '";
    let a_commands = ["cmd /c git add a.txt", "rm a.txt"];
    let b_commands = ["cmd /c git add b.txt", "cmd /c rm b.txt", quote];
    for (name, commands) in [("a", a_commands.as_slice()), ("b", b_commands.as_slice())] {
        std::fs::write(project.join(format!("{name}.txt")), name)?;
        for (action, command) in ["Stage", "Remove", "Quote"].into_iter().zip(commands) {
            let prompt = format!("{action} {name}.");
            let args = json!({"command":command,"state_effect":"mutation","summary":prompt});
            let step = call(&format!("{action}-{name}"), "run_command", &args);
            script.rounds.lock().unwrap().insert(prompt, vec![step]);
        }
    }
    let turn = paused(&s, &chat, "Stage a.").await?;
    let operation = &s.gw.approval_requests(&chat).await?[0]["approval"]["operation"];
    assert_eq!(operation["rule_prefixes"], json!(["git add"]));
    approve(&s, &chat, "allow", Some("always")).await?;
    delivered(&s, &chat, &turn).await?;
    let body = json!({"kind":"project","workspace_mode":"local","title":"Second chat",
        "project_id":s.gw.get("/projects").await?.data()["projects"][0]["id"]});
    let reply = s.gw.post("/sessions", body).await?;
    let second_chat = reply.data()["session"]["id"].as_str().unwrap();
    let turn = s.gw.say_turn(second_chat, "Stage b.").await?;
    delivered(&s, second_chat, &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    paused(&s, second_chat, "Quote b.").await?;
    let turn = paused(&s, &chat, "Remove a.").await?;
    approve(&s, &chat, "deny", Some("always")).await?;
    delivered(&s, &chat, &turn).await?;
    let turn = s.gw.say_turn(&chat, "Remove b.").await?;
    delivered(&s, &chat, &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    let result = outputs(&s, &chat, &turn, &script, "Remove b.").await?;
    assert!(result.join("\n").contains("denied_by_rule"));
    assert!(project.join("b.txt").is_file());
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn allowed_folder_is_in_scope() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-FOLDERS")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_TEST_READ_SANDBOX", "unavailable")
        .env("BUTLER_TEST_SECRET_READ_DENIAL", "unavailable");
    let work = setup.sandbox.home.join("work");
    std::fs::create_dir(&work)?;
    std::fs::write(work.join("a.txt"), "allowed-folder-marker")?;
    std::fs::write(work.join(".env"), "private-marker")?;
    let s = setup.start().await?;
    for path in [
        "~".to_owned(),
        s.sandbox.data.to_string_lossy().into_owned(),
    ] {
        let refused = s.gw.post("/allowed-folders", json!({"path":path})).await?;
        assert_eq!(refused.status, 400, "{}", refused.text);
        assert!(
            refused.text.contains("folder_protected"),
            "{}",
            refused.text
        );
    }
    let added =
        s.gw.post("/allowed-folders", json!({"path":"~/work"}))
            .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let listed = s.gw.get("/allowed-folders").await?;
    let id = listed.data()["folders"][0]["rule_id"].clone();
    let chat = "general";
    let allowed_read = call(
        "cat",
        "run_command",
        &json!({"command":"cat ~/work/a.txt","cwd":"~/work","summary":"Read file","state_effect":"read_only"}),
    );
    for (prompt, step) in [
        ("Read allowed file.", read("read", "~/work/a.txt")),
        ("Run allowed read.", allowed_read.clone()),
    ] {
        script
            .rounds
            .lock()
            .unwrap()
            .insert(prompt.into(), vec![step]);
        let turn = s.gw.say_turn(chat, prompt).await?;
        delivered(&s, chat, &turn).await?;
        assert_counts(&s, &turn, 0, 0)?;
        assert!(
            outputs(&s, chat, &turn, &script, prompt)
                .await?
                .iter()
                .any(|output| output.contains("allowed-folder-marker"))
        );
    }
    let prompt = "Read protected file.";
    script.rounds.lock().unwrap().insert(prompt.into(), vec![call("protected", "run_command",
        &json!({"command":"cat ~/work/.env","cwd":"~/work","summary":"Read config","state_effect":"read_only"}))]);
    let turn = paused(&s, chat, prompt).await?;
    approve(&s, chat, "deny", None).await?;
    delivered(&s, chat, &turn).await?;

    let controls =
        s.gw.patch("/sessions/general/controls", json!({"access_mode":"auto"}))
            .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    let prompt = "Write in the allowed folder.";
    script.rounds.lock().unwrap().insert(prompt.into(), vec![call("touch", "run_command",
        &json!({"command":"touch new.txt","cwd":"~/work","summary":"Create file","state_effect":"mutation"}))]);
    use butler_platform::command_sandbox;
    if command_sandbox::project_write_mechanism() == "seatbelt"
        || (command_sandbox::WINDOWS_SHELL && command_sandbox::folder_write_available())
        || command_sandbox::metadata_tier_available()
        || command_sandbox::mount_tier_available()
    {
        assert!(command_sandbox::folder_write_available());
    }
    if command_sandbox::folder_write_available() {
        let turn = s.gw.say_turn(chat, prompt).await?;
        delivered(&s, chat, &turn).await?;
        assert_counts(&s, &turn, 0, 0)?;
        assert!(work.join("new.txt").is_file());
    } else {
        let turn = paused(&s, chat, prompt).await?;
        approve(&s, chat, "deny", None).await?;
        delivered(&s, chat, &turn).await?;
    }
    let removed =
        s.gw.post("/allowed-folders/remove", json!({"rule_id":id}))
            .await?;
    assert_eq!(removed.status, 200, "{}", removed.text);
    let prompt = "Read after removing the folder.";
    script
        .rounds
        .lock()
        .unwrap()
        .insert(prompt.into(), vec![allowed_read]);
    paused(&s, chat, prompt).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn read_only_pipeline_without_read_sandbox() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-READ-PIPELINE")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("BUTLER_TEST_READ_SANDBOX", "unavailable")
        .env("BUTLER_TEST_SECRET_READ_DENIAL", "unavailable");
    let parent = setup.sandbox.home.join("project");
    std::fs::create_dir(&parent)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    let project = parent.join("작업 Project");
    std::fs::create_dir(project.join("src"))?;
    std::fs::write(project.join("src/a.txt"), "marker")?;
    std::fs::write(project.join("a.txt"), "marker")?;
    std::fs::write(project.join("a.tmp"), "keep")?;
    for (id, prompt, command, marker) in [
        (
            "grep",
            "Count matching lines.",
            if WINDOWS_SHELL {
                "sls marker src/a.txt | Measure-Object"
            } else {
                "grep -n marker src/a.txt | wc -l"
            },
            "1",
        ),
        (
            "cat",
            "Read the first line.",
            if WINDOWS_SHELL {
                "gc a.txt | Select-Object -First 1"
            } else {
                "cat a.txt | head -1"
            },
            "marker",
        ),
    ] {
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![call(
                id,
                "run_command",
                &json!({"command":command,"summary":prompt,"state_effect":"read_only"}),
            )],
        );
        let turn = s.gw.say_turn(&chat, prompt).await?;
        delivered(&s, &chat, &turn).await?;
        assert_counts(&s, &turn, 0, 0)?;
        assert!(
            outputs(&s, &chat, &turn, &script, prompt)
                .await?
                .iter()
                .any(|output| output.contains(marker))
        );
    }
    let prompt = "Delete temporary files.";
    script.rounds.lock().unwrap().insert(prompt.into(), vec![call("delete", "run_command",
        &json!({"command":"find . -name '*.tmp' -delete","summary":prompt,"state_effect":"read_only"}))]);
    paused(&s, &chat, prompt).await?;
    assert!(project.join("a.tmp").is_file());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn deny_rule_blocks_in_every_mode() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-DENY")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let parent = setup.sandbox.home.join("project");
    std::fs::create_dir(&parent)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    let project = parent.join("작업 Project");
    for name in ["a", "b"] {
        std::fs::write(project.join(format!("{name}.txt")), name)?;
        script.rounds.lock().unwrap().insert(
            format!("Remove file {name}."),
            vec![call(
                name,
                "run_command",
                &json!({"command":format!("rm {name}.txt"),
            "state_effect":"mutation","summary":"Remove file"}),
            )],
        );
    }
    let turn = paused(&s, &chat, "Remove file a.").await?;
    approve(&s, &chat, "deny", Some("always")).await?;
    delivered(&s, &chat, &turn).await?;
    let controls =
        s.gw.patch(
            &format!("/sessions/{chat}/controls"),
            json!({"access_mode":"full_access"}),
        )
        .await?;
    assert_eq!(controls.status, 200, "{}", controls.text);
    let turn = s.gw.say_turn(&chat, "Remove file b.").await?;
    delivered(&s, &chat, &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    assert!(
        outputs(&s, &chat, &turn, &script, "Remove file b.")
            .await?
            .iter()
            .any(|output| output.contains("denied_by_rule"))
    );
    assert!(project.join("b.txt").is_file());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn proposed_rule_needs_one_click() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-PROPOSAL")?
        .access(Access::AskExceptReads)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let parent = setup.sandbox.home.join("project");
    std::fs::create_dir(&parent)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    let prefix = NEW_FILE_COMMAND.to_ascii_lowercase();
    for (prompt, action) in [
        ("Propose the rule.", "deny"),
        ("Propose it again.", "allow"),
    ] {
        script.rounds.lock().unwrap().insert(
            prompt.into(),
            vec![call(
                action,
                "propose_permission_rule",
                &json!({"effect":"allow","kind":"command_prefix","pattern":prefix,
                "scope":"always","reason":"Create files without asking"}),
            )],
        );
        let turn = paused(&s, &chat, prompt).await?;
        let rows = s.gw.get("/authority-permissions").await?;
        assert_eq!(rows.data()["permissions"], json!([]));
        approve(&s, &chat, action, None).await?;
        delivered(&s, &chat, &turn).await?;
        let rows = s.gw.get("/authority-permissions").await?;
        if action == "deny" {
            assert_eq!(rows.data()["permissions"], json!([]));
        } else {
            assert_eq!(rows.data()["permissions"][0]["target"], prefix);
            assert_eq!(rows.data()["permissions"][0]["scope"], "always");
        }
    }
    let prompt = "Create file n.";
    script.rounds.lock().unwrap().insert(
        prompt.into(),
        vec![call(
            "touch",
            "run_command",
            &json!({"command":format!("{NEW_FILE_COMMAND} n.txt"),"summary":prompt,"state_effect":"mutation"}),
        )],
    );
    let turn = s.gw.say_turn(&chat, prompt).await?;
    delivered(&s, &chat, &turn).await?;
    assert_counts(&s, &turn, 0, 0)?;
    assert!(parent.join("작업 Project/n.txt").is_file());
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn global_rule_runs_in_schedule() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let setup = Setup::new("APPROVAL-SCHEDULE")?
        .access(Access::AskExceptReads)
        .clock_after_daily_jobs("2026-09-27T12:00:00.000Z")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let parent = setup.sandbox.home.join("project");
    std::fs::create_dir(&parent)?;
    let mut s = setup.start().await?;
    let chat = crate::project_workspace::bind_project(&mut s, &parent).await?;
    for (prompt, file) in [
        ("Create an initial file.", "initial.txt"),
        ("Create the scheduled file.", "s.txt"),
    ] {
        script.rounds.lock().unwrap().insert(prompt.into(), vec![call(file, "run_command",
            &json!({"command":format!("{NEW_FILE_COMMAND} {file}"),"summary":prompt,"state_effect":"mutation"}))]);
    }
    let turn = paused(&s, &chat, "Create an initial file.").await?;
    approve(&s, &chat, "allow", Some("always")).await?;
    delivered(&s, &chat, &turn).await?;

    let created =
        s.gw.post(
            "/automations",
            json!({"title":"Create the scheduled file.",
        "prompt_body":"Create the scheduled file.","target_session_id":chat,"schedule_type":"once",
        "run_at":"2000-01-01T00:00:00.000Z","access_mode":"ask_first"}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let body = created.data();
    let schedule = body["automation"]["id"].as_str().unwrap();
    let due = s.gw.post("/automations/dispatch-due", json!({})).await?;
    assert_eq!(due.status, 202, "{}", due.text);
    let run = run_where(&s, schedule, |run| {
        run["trigger"] == "scheduled" && run["turn_id"].is_string()
    })
    .await?;
    let turn = run["turn_id"].as_str().unwrap();
    delivered(&s, &chat, turn).await?;
    let run = run_where(&s, schedule, |run| run["turn_id"] == turn).await?;
    assert_ne!(run["safe_error_code"], "schedule_permission_required");
    assert!(parent.join("작업 Project/s.txt").is_file());
    s.finish().await?;
    server.abort();
    Ok(())
}
